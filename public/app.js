const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const meterEl = document.getElementById("meter");
const providerEl = document.getElementById("provider");
const voiceEl = document.getElementById("voice");
const roleEl = document.getElementById("role");
const roleField = document.getElementById("roleField");
const characterEl = document.getElementById("character");

let config = null; // ответ /config: списки провайдеров и голосов
let pc = null;
let dc = null;
let micStream = null;
let audioCtx = null;
let rafId = null;
let audioEl = null;
let yandex = null; // состояние Yandex-сессии: { ws, micNode, playNode, queue, ... }

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

// Подтягиваем с сервера список провайдеров, голосов и характеров —
// единый источник, чтобы не дублировать их в браузере.
async function loadConfig() {
  try {
    // Относительный путь (без ведущего "/"), чтобы работать и в корне,
    // и под подпутём вроде /voice/ за общим доменом.
    config = await (await fetch("config")).json();

    // Движки: недоступные (без ключей на сервере) показываем выключенными.
    providerEl.replaceChildren();
    for (const p of config.providers) {
      const opt = document.createElement("option");
      opt.value = p.key;
      opt.textContent = p.enabled ? p.label : `${p.label} (не настроен)`;
      opt.disabled = !p.enabled;
      if (p.key === config.defaultProvider && p.enabled) opt.selected = true;
      providerEl.append(opt);
    }
    // Характеры общие для обоих движков.
    fillSelect(characterEl, config.characters.map((c) => ({ value: c.key, label: c.label })), config.defaults.character);
    applyProvider();
  } catch {
    // Сервер недоступен — оставляем пустые списки, старт всё равно возможен
  }
}

// Список голосов зависит от выбранного движка; амплуа — только у Yandex.
function applyProvider() {
  if (!config) return;
  const prov = config[providerEl.value];
  if (prov) fillSelect(voiceEl, prov.voices.map((v) => ({ value: v, label: v })), prov.defaultVoice);

  const hasRoles = Array.isArray(prov?.roles) && prov.roles.length > 0;
  roleField.hidden = !hasRoles;
  if (hasRoles) fillSelect(roleEl, prov.roles.map((r) => ({ value: r, label: r })), prov.defaultRole);
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

// Общий вход: блокируем управление, дальше зовём нужный движок.
async function start() {
  startBtn.disabled = true;
  providerEl.disabled = voiceEl.disabled = roleEl.disabled = characterEl.disabled = true;
  setStatus("Соединяюсь", "pending");

  try {
    if (providerEl.value === "yandex") await connectYandex();
    else await connectOpenAI();
    stopBtn.disabled = false;
  } catch (err) {
    setStatus("Не удалось соединиться", "error");
    addLine("assistant", String(err.message || err));
    startBtn.disabled = false;
    providerEl.disabled = voiceEl.disabled = roleEl.disabled = characterEl.disabled = false;
  }
}

// Yandex Realtime — WebSocket + LPCM через прокси на нашем сервере.
// Прокси держит API-ключ и общается с Яндексом; браузер шлёт/принимает PCM.
async function connectYandex() {
  // WS к нашему прокси. Путь относительный ("rt"), поэтому работает и в корне,
  // и под /voice/; http→ws, https→wss.
  const wsUrl = new URL("rt", location.href);
  wsUrl.protocol = wsUrl.protocol.replace("http", "ws");
  wsUrl.searchParams.set("voice", voiceEl.value);
  wsUrl.searchParams.set("role", roleEl.value);
  wsUrl.searchParams.set("character", characterEl.value);

  const ws = new WebSocket(wsUrl);
  yandex = { ws, queue: [], readOffset: 0, epoch: 0, curEpoch: null, assistantLine: null };

  // Ждём открытия и параметров аудио (событие proxy.ready с частотой).
  const rate = await new Promise((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("WebSocket к серверу не открылся")), { once: true });
    ws.addEventListener("close", () => reject(new Error("Сервер закрыл соединение")), { once: true });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "proxy.ready") resolve(msg.outRate || 44100);
      else handleYandexEvent(msg);
    });
  });

  // Аудиоконтекст на частоте сервера (вход = выход), микрофон, захват и воспроизведение.
  audioCtx = new AudioContext({ sampleRate: rate });
  await audioCtx.resume().catch(() => {}); // на случай автоплей-политики браузера
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const source = audioCtx.createMediaStreamSource(micStream);

  // Захват микрофона в PCM16 и отправка на прокси. ScriptProcessor устарел,
  // но работает везде и не требует отдельного worklet-файла (важно под /voice/).
  yandex.micNode = audioCtx.createScriptProcessor(4096, 1, 1);
  yandex.micNode.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const f32 = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bufToB64(pcm.buffer) }));
  };
  source.connect(yandex.micNode);
  yandex.micNode.connect(audioCtx.destination); // нужно, чтобы onaudioprocess срабатывал; выход молчит

  // Воспроизведение ответа: тянем PCM из очереди. Пусто — тишина.
  yandex.playNode = audioCtx.createScriptProcessor(4096, 1, 1);
  yandex.playNode.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    let i = 0;
    while (i < out.length && yandex.queue.length) {
      const chunk = yandex.queue[0];
      const n = Math.min(chunk.length - yandex.readOffset, out.length - i);
      out.set(chunk.subarray(yandex.readOffset, yandex.readOffset + n), i);
      i += n;
      yandex.readOffset += n;
      if (yandex.readOffset >= chunk.length) {
        yandex.queue.shift();
        yandex.readOffset = 0;
      }
    }
    for (; i < out.length; i++) out[i] = 0;
  };
  yandex.playNode.connect(audioCtx.destination);

  // Если сервер закроет соединение уже во время разговора — аккуратно завершаем.
  ws.addEventListener("close", () => {
    if (yandex) {
      setStatus("Соединение закрыто", "idle");
      stop();
    }
  });

  drawMeter(micStream, audioCtx);
  setStatus("Слушаю", "live");
}

// Декод base64-PCM16 → Float32 и постановка в очередь воспроизведения.
function enqueuePcm(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
  yandex.queue.push(f32);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// События Yandex Realtime (имена совместимы с OpenAI Realtime).
function handleYandexEvent(msg) {
  switch (msg.type) {
    case "session.created":
      setStatus("Слушаю", "live");
      break;

    case "conversation.item.input_audio_transcription.completed":
      if (msg.transcript) addLine("user", msg.transcript);
      break;

    case "response.created":
      // Новый ответ — своя «эпоха»; дельзы прошлой, прерванной, игнорируем.
      yandex.curEpoch = yandex.epoch;
      yandex.assistantLine = null;
      break;

    case "response.output_text.delta":
      if (msg.delta) {
        if (!yandex.assistantLine) yandex.assistantLine = addLine("assistant", "");
        yandex.assistantLine.append(msg.delta);
        logEl.scrollTop = logEl.scrollHeight;
      }
      setStatus("Говорит", "speaking");
      break;

    case "response.output_audio.delta":
      // Играем только аудио текущего ответа (эпоха совпадает).
      if (yandex.curEpoch === yandex.epoch && msg.delta) enqueuePcm(msg.delta);
      setStatus("Говорит", "speaking");
      break;

    // Пользователь начал говорить поверх ответа — обрываем воспроизведение
    // (чистим очередь) и меняем эпоху, чтобы хвост прошлого ответа не доиграл.
    case "input_audio_buffer.speech_started":
      yandex.epoch += 1;
      yandex.curEpoch = null;
      yandex.queue = [];
      yandex.readOffset = 0;
      setStatus("Слушаю", "live");
      break;

    case "error":
      setStatus("Ошибка", "error");
      addLine("assistant", msg.error?.message ?? "неизвестная ошибка");
      break;
  }
}

// OpenAI Realtime — WebRTC напрямую из браузера по эфемерному ключу.
async function connectOpenAI() {
  {
    // 1. Берём короткоживущий ключ у своего сервера, передаём выбранные
    //    голос и характер (сервер проверит их по белому списку)
    const tokenRes = await fetch("session", {
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

// Индикатор громкости — видно, что микрофон реально слышит.
// ctx можно передать (Yandex использует общий контекст), иначе создаём свой.
function drawMeter(stream, ctx) {
  audioCtx = ctx || new AudioContext();
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
  // Yandex-сессию гасим первой и обнуляем, чтобы onclose не зациклил stop().
  if (yandex) {
    const y = yandex;
    yandex = null;
    try { y.ws?.close(); } catch {}
    try { y.micNode?.disconnect(); } catch {}
    try { y.playNode?.disconnect(); } catch {}
  }
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
  providerEl.disabled = voiceEl.disabled = roleEl.disabled = characterEl.disabled = false;
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
providerEl.addEventListener("change", applyProvider); // сменили движок — обновить список голосов
loadConfig();
