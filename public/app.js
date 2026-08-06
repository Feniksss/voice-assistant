const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const meterEl = document.getElementById("meter");
const voiceEl = document.getElementById("voice");
const characterEl = document.getElementById("character");

let pc = null;
let dc = null;
let micStream = null;
let audioCtx = null;
let rafId = null;
let audioEl = null;

function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function addLine(who, text) {
  const el = document.createElement("p");
  el.className = `line line--${who}`;
  const label = document.createElement("span");
  label.className = "who";
  label.textContent = who === "user" ? "вы" : "ассистент";
  // Текст добавляем текстовым узлом, а не через innerHTML — иначе строка
  // ошибки или транскрипт с < > попали бы в разметку как HTML.
  el.append(label, document.createTextNode(text));
  logEl.append(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

// Подтягиваем списки голосов и характеров с сервера — единый источник,
// чтобы не дублировать их в браузере.
async function loadConfig() {
  try {
    const cfg = await (await fetch("/config")).json();
    fillSelect(voiceEl, cfg.voices.map((v) => ({ value: v, label: v })), cfg.defaults.voice);
    fillSelect(characterEl, cfg.characters.map((c) => ({ value: c.key, label: c.label })), cfg.defaults.character);
  } catch {
    // Сервер недоступен — оставляем пустые списки, старт всё равно возможен
  }
}

function fillSelect(el, options, selected) {
  el.replaceChildren();
  for (const { value, label } of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === selected) opt.selected = true;
    el.append(opt);
  }
}

async function start() {
  startBtn.disabled = true;
  voiceEl.disabled = characterEl.disabled = true;
  setStatus("Соединяюсь", "pending");

  try {
    // 1. Берём короткоживущий ключ у своего сервера, передаём выбранные
    //    голос и характер (сервер проверит их по белому списку)
    const tokenRes = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: voiceEl.value, character: characterEl.value }),
    });
    if (!tokenRes.ok) throw new Error("Сервер не выдал ключ сессии");
    const token = await tokenRes.json();
    const clientSecret = token.value ?? token.client_secret?.value;

    // 2. Поднимаем WebRTC-соединение
    pc = new RTCPeerConnection();

    // Голос ассистента приходит отдельной дорожкой — просто отдаём его в <audio>.
    // Дорожка одна на всю сессию, поэтому при перебивании не рвём srcObject
    // (иначе замолчат и следующие ответы), а глушим её через muted.
    audioEl = new Audio();
    audioEl.autoplay = true;
    pc.ontrack = (e) => (audioEl.srcObject = e.streams[0]);

    // 3. Микрофон в соединение
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    pc.addTrack(micStream.getTracks()[0], micStream);
    drawMeter(micStream);

    // 4. Канал данных — через него идут события: транскрипты, вызовы функций и т.д.
    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("message", (e) => handleEvent(JSON.parse(e.data)));
    dc.addEventListener("open", () => setStatus("Слушаю", "live"));

    // 5. SDP-обмен напрямую с OpenAI
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!sdpRes.ok) throw new Error("OpenAI отклонил WebRTC-соединение");

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpRes.text(),
    });

    stopBtn.disabled = false;
  } catch (err) {
    setStatus("Не удалось соединиться", "error");
    addLine("assistant", String(err.message || err));
    startBtn.disabled = false;
    voiceEl.disabled = characterEl.disabled = false;
  }
}

// Реплики приходят кусками, поэтому дописываем в один и тот же абзац
const streaming = {};

function handleEvent(evt) {
  switch (evt.type) {
    case "conversation.item.input_audio_transcription.delta":
      appendDelta("user", evt.item_id, evt.delta);
      break;

    case "conversation.item.input_audio_transcription.completed":
      delete streaming[evt.item_id];
      break;

    case "response.output_audio_transcript.delta":
      if (audioEl) audioEl.muted = false; // ассистент снова говорит — вернуть звук
      appendDelta("assistant", evt.item_id, evt.delta);
      setStatus("Говорит", "speaking");
      break;

    case "response.done":
      setStatus("Слушаю", "live");
      break;

    // Пользователь начал говорить поверх ответа — модель сама замолкает,
    // но в буфере <audio> ещё доигрывает хвост прежней реплики. Глушим его,
    // звук вернём, когда ассистент заговорит снова (см. transcript.delta).
    case "input_audio_buffer.speech_started":
      if (audioEl) audioEl.muted = true;
      setStatus("Слушаю", "live");
      break;

    case "error":
      setStatus("Ошибка", "error");
      addLine("assistant", evt.error?.message ?? "неизвестная ошибка");
      break;
  }
}

function appendDelta(who, id, delta) {
  if (!streaming[id]) streaming[id] = addLine(who, "");
  streaming[id].append(delta);
  logEl.scrollTop = logEl.scrollHeight;
}

// Индикатор громкости — видно, что микрофон реально слышит
function drawMeter(stream) {
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    meterEl.style.transform = `scaleX(${Math.min(1, peak / 48)})`;
    rafId = requestAnimationFrame(tick);
  };
  tick();
}

function stop() {
  dc?.close();
  pc?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  cancelAnimationFrame(rafId);
  meterEl.style.transform = "scaleX(0)";
  if (audioEl) audioEl.srcObject = null;
  pc = dc = micStream = audioCtx = audioEl = null;

  setStatus("Разговор завершён", "idle");
  startBtn.disabled = false;
  stopBtn.disabled = true;
  voiceEl.disabled = characterEl.disabled = false;
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
loadConfig();
