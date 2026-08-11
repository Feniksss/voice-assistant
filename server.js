import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────── OpenAI Realtime ───────────────────────────
// Всё, что ниже, можно переопределить через .env, не залезая в код.
const MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2";
const TRANSCRIBE_MODEL = process.env.REALTIME_TRANSCRIBE_MODEL || "gpt-realtime-whisper";
const DEFAULT_VOICE = process.env.REALTIME_VOICE || "marin";
// Как ассистент чувствует конец реплики: low — ждёт дольше и не перебивает.
const EAGERNESS = process.env.REALTIME_EAGERNESS || "low";
const SPEED = Number(process.env.REALTIME_SPEED || "0.95");
const MAX_OUTPUT_TOKENS = Number(process.env.REALTIME_MAX_OUTPUT_TOKENS || "400");

// Разрешённые голоса OpenAI. Из этого же списка страница строит выпадающий
// список, и по нему же проверяется значение, пришедшее от браузера.
const VOICES = ["marin", "cedar", "verse", "alloy", "ash", "ballad", "coral", "sage", "echo", "shimmer"];

const OPENAI_ENABLED = Boolean(process.env.OPENAI_API_KEY);

// ─────────────────────────── Yandex Realtime ───────────────────────────
// Транспорт — WebSocket + LPCM, авторизация по IAM-токену (Bearer).
// Значения берём из .env; провайдер включается, когда заданы endpoint,
// модель и источник токена. Сам WS-прокси добавляется отдельным шагом.
const YANDEX = {
  url: process.env.YANDEX_REALTIME_URL || "wss://ai.api.cloud.yandex.net/v1/realtime",
  model: process.env.YANDEX_REALTIME_MODEL || "speech-realtime-250923",
  folderId: process.env.YANDEX_FOLDER_ID || "",
  apiKey: process.env.YANDEX_API_KEY || "", // ключ AI Studio, scope yc.ai.foundationModels.execute
  // Частоты дискретизации PCM (вход = выход в текущем клиенте). 44100 — как в примере Яндекса.
  inRate: Number(process.env.YANDEX_IN_RATE || "44100"),
  outRate: Number(process.env.YANDEX_OUT_RATE || "44100"),
  voices: (process.env.YANDEX_VOICES || "dasha,julia,lera,marina,alexander,kirill,anton,alena,jane,omazh,zahar,ermil,filipp")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  defaultVoice: process.env.YANDEX_VOICE || "dasha",
  speed: Number(process.env.YANDEX_SPEED || "1.0"),
  // Просить модель размечать ударение знаком + (TTS-разметка v3). Управление
  // ударением синтеза. Отключить: YANDEX_STRESS_MARKS=0.
  stressMarks: (process.env.YANDEX_STRESS_MARKS ?? "1") !== "0",
  // Подсказки под синтезатор: протяжные междометия + паузы sil<[мс]>, чтобы
  // "эм"/"о" не читались по буквам и была задержка. Отключить: =0.
  speechShaping: (process.env.YANDEX_SPEECH_SHAPING ?? "1") !== "0",
  // Серверный VAD: сколько миллисекунд тишины ждать, прежде чем счесть,
  // что человек договорил. Больше — терпеливее, не обрывает паузы в речи
  // (ценой чуть более поздней реакции после реального конца фразы).
  vadSilenceMs: Number(process.env.YANDEX_VAD_SILENCE_MS || "800"),
  // Порог чувствительности к речи (0..1). Ниже — чутче к тихой речи.
  vadThreshold: Number(process.env.YANDEX_VAD_THRESHOLD || "0.5"),
};
const YANDEX_ENABLED = Boolean(YANDEX.apiKey && YANDEX.folderId);

// Какие амплуа поддерживает каждый голос. Важно: невалидная пара голос+амплуа
// не отклоняется при session.update, но роняет синтез ("Unknown role ... for ...").
// Голоса, которых здесь нет, используются без амплуа (селектор скрывается).
// Премиум-голоса уточняются по доке voices — пока без ролей, чтобы не падать.
const YANDEX_VOICE_ROLES = {
  jane: ["neutral", "good", "evil"],
  omazh: ["neutral", "evil"],
  zahar: ["neutral", "good"],
  ermil: ["neutral", "good"],
  alena: ["neutral", "good"],
};

const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || (OPENAI_ENABLED ? "openai" : "yandex");

if (!OPENAI_ENABLED && !YANDEX_ENABLED) {
  console.error("Не настроен ни один провайдер: впишите OPENAI_API_KEY или задайте YANDEX_* в .env.");
  process.exit(1);
}

// ───────────────────────────── Промпты ─────────────────────────────────
// Общая часть промпта — именно она сильнее всего влияет на «живость» речи.
const BASE = `
Ты — голосовой собеседник. Общайся по-русски, если человек не перешёл на другой язык.

Главное — звучать как живой человек, а не диктор:
- Короткими фразами, одна мысль — одна реплика.
- Иногда запинайся и тяни ("эм", "ну", "как бы", "слушай") — но не в каждой фразе.
- Вставляй короткие "угу", "ага", "понял", когда слушаешь или соглашаешься.
- Реагируй эмоцией вслух: "о!", "хм", "ха", удивление, сомнение.
- Меняй длину реплик: где-то одно слово, где-то целая фраза. Не держи ровный темп.
- Без канцелярита, без markdown, без перечислений вслух.
- Отвечай сразу по делу, не начинай с "конечно", "разумеется".
- Если вопрос неоднозначный — переспроси одной короткой фразой.
- Не читай лекций: лучше сказать меньше и дать человеку вставить слово.

Если тебя перебили — сразу замолкай и слушай, не договаривай начатое.
`.trim();

// Пресеты характера — общие для обоих провайдеров (это просто системный промпт).
const CHARACTERS = {
  alive: {
    label: "Живой собеседник",
    instructions: `${BASE}\n\nДержись тепло и непринуждённо, будто болтаешь с хорошим знакомым.`,
  },
  calm: {
    label: "Спокойный",
    instructions: `${BASE}\n\nГовори спокойно и размеренно, мягким тоном, чуть медленнее. Делай паузы, не части.`,
  },
  business: {
    label: "Деловой",
    instructions: `${BASE}\n\nДержись собранно и по делу, вежливо, но без лишней болтовни. Минимум сора в речи, чуть строже.`,
  },
};
const DEFAULT_CHARACTER = "alive";

app.use(express.static("public"));
app.use(express.json());

// Единый источник для интерфейса: какие провайдеры доступны и их списки.
app.get("/config", (_req, res) => {
  res.json({
    providers: [
      { key: "openai", label: "OpenAI Realtime", enabled: OPENAI_ENABLED },
      { key: "yandex", label: "Yandex Realtime", enabled: YANDEX_ENABLED },
    ],
    defaultProvider: DEFAULT_PROVIDER,
    // Характеры общие — это системный промпт, он одинаково применим к обоим.
    characters: Object.entries(CHARACTERS).map(([key, c]) => ({ key, label: c.label })),
    defaults: { character: DEFAULT_CHARACTER },
    openai: { voices: VOICES, defaultVoice: DEFAULT_VOICE },
    yandex: {
      voices: YANDEX.voices,
      defaultVoice: YANDEX.defaultVoice,
      // Амплуа зависит от голоса — страница показывает только валидные.
      voiceRoles: YANDEX_VOICE_ROLES,
    },
  });
});

/**
 * Простой лимит на выдачу сессий: без него любой, кто открыл хост,
 * может дёргать /session и жечь квоту. Держим окно в памяти по IP —
 * для одного инстанса этого достаточно.
 */
const RATE_LIMIT = 10; // запросов
const RATE_WINDOW_MS = 60_000; // за минуту
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT;
}

/**
 * OpenAI: браузеру нельзя давать настоящий API-ключ. Сервер меняет свой
 * постоянный ключ на короткоживущий client_secret, с которым браузер уже
 * сам соединяется с OpenAI напрямую по WebRTC. Голос и характер приходят
 * из выпадающих списков — проверяем их по белым спискам.
 */
app.post("/session", async (req, res) => {
  if (!OPENAI_ENABLED) return res.status(404).json({ error: "Провайдер OpenAI не настроен." });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Слишком много запросов, попробуйте через минуту." });
  }

  const voice = VOICES.includes(req.body?.voice) ? req.body.voice : DEFAULT_VOICE;
  const character = CHARACTERS[req.body?.character] ?? CHARACTERS[DEFAULT_CHARACTER];

  try {
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: MODEL,
          instructions: character.instructions,
          // Потолок длины ответа: короткие реплики звучат разговорнее.
          max_output_tokens: MAX_OUTPUT_TOKENS,
          audio: {
            input: {
              transcription: { model: TRANSCRIBE_MODEL, language: "ru" },
              // Чистит вход (near_field — гарнитура/наушники), меньше ложных
              // срабатываний определения конца реплики.
              noise_reduction: { type: "near_field" },
              // Определение конца реплики. semantic_vad решает по смыслу,
              // а не по тишине; eagerness=low — ждёт дольше и не перебивает.
              turn_detection: {
                type: "semantic_vad",
                eagerness: EAGERNESS,
                interrupt_response: true,
              },
            },
            output: {
              voice,
              speed: SPEED,
            },
          },
        },
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }

    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Открой http://localhost:${PORT}`);
  console.log(
    `Провайдеры: OpenAI=${OPENAI_ENABLED ? "on" : "off"}, Yandex=${YANDEX_ENABLED ? "on" : "off"}; по умолчанию — ${DEFAULT_PROVIDER}`,
  );
});

// ─────────────────────────── Yandex WS-прокси ──────────────────────────
// Браузер ⇄ (WS) наш сервер ⇄ (WS + Api-Key) Yandex Realtime.
// API-ключ живёт только здесь; браузеру не отдаём. Наружу от клиента
// пропускаем лишь аудио, чтобы нельзя было переопределить промпт/голос.
if (YANDEX_ENABLED) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/rt") return socket.destroy(); // не наш путь

    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return socket.destroy();

    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  });

  wss.on("connection", (client, req) => {
    const params = new URL(req.url, "http://localhost").searchParams;
    const voice = YANDEX.voices.includes(params.get("voice")) ? params.get("voice") : YANDEX.defaultVoice;
    // Амплуа отправляем ТОЛЬКО если оно валидно для выбранного голоса — иначе синтез падает.
    const allowedRoles = YANDEX_VOICE_ROLES[voice] || [];
    const role = allowedRoles.includes(params.get("role")) ? params.get("role") : null;
    const character = CHARACTERS[params.get("character")] ?? CHARACTERS[DEFAULT_CHARACTER];

    const upstream = new WebSocket(`${YANDEX.url}?model=gpt://${YANDEX.folderId}/${YANDEX.model}`, {
      headers: { Authorization: `Api-Key ${YANDEX.apiKey}` },
    });

    // TTS-разметка ударения: v3 трактует текст как размеченный, поэтому знак +
    // перед ударной гласной в ответе модели управляет ударением синтеза.
    const stressHint = YANDEX.stressMarks
      ? "\n\nПроизношение: если ударение в слове неоднозначно или ты не уверен, как его произнесёт синтезатор, ставь знак + прямо перед ударной гласной в тексте ответа (например: з+амок, звон+ит, кл+ючи, кот+орый, красив+ее). Помечай только такие слова, очевидные не трогай. Сам знак + не произноси."
      : "";

    // Огранка под синтезатор: он читает текст буквально и не играет интонацию сам.
    const shapingHint = YANDEX.speechShaping
      ? "\n\nТебя озвучивает синтезатор речи — он читает текст буквально и не добавит интонацию сам. Поэтому:\n- Заминки и междометия пиши протяжно: \"э-э\", \"м-м\", \"ну-у\", \"а-а\" — короткие \"эм\"/\"о\" синтезатор читает по буквам.\n- Для паузы или задержки вставляй прямо в текст sil<[300]> (число — миллисекунды), например: \"Хм sil<[400]> дай подумать\".\n- Эмоцию передавай словами и знаками (!, …), не рассчитывай, что синтезатор сыграет её интонацией."
      : "";

    upstream.on("open", () => {
      // Конфигурация сессии задаётся на сервере — промпт и голос под контролем.
      upstream.send(
        JSON.stringify({
          type: "session.update",
          session: {
            instructions: character.instructions + shapingHint + stressHint,
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: YANDEX.inRate },
                turn_detection: {
                  type: "server_vad",
                  threshold: YANDEX.vadThreshold,
                  silence_duration_ms: YANDEX.vadSilenceMs,
                },
              },
              output: {
                format: { type: "audio/pcm", rate: YANDEX.outRate },
                voice,
                ...(role ? { role } : {}), // амплуа — только если валидно для голоса
                speed: YANDEX.speed,
              },
            },
          },
        }),
      );
      // Сообщаем браузеру частоты, чтобы он захватывал/играл PCM правильно.
      client.send(JSON.stringify({ type: "proxy.ready", inRate: YANDEX.inRate, outRate: YANDEX.outRate }));
    });

    // upstream → браузер: события как есть (транскрипты, аудио-дельты, ошибки).
    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });
    upstream.on("close", () => client.close());
    upstream.on("error", (e) => {
      try {
        client.send(JSON.stringify({ type: "error", error: { message: `upstream: ${e.message}` } }));
      } catch {}
      client.close();
    });

    // браузер → upstream: пропускаем только аудио.
    client.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "input_audio_buffer.append" && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data.toString());
      }
    });
    client.on("close", () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    });
    client.on("error", () => {
      try {
        upstream.close();
      } catch {}
    });
  });
}

export { server };
