import express from "express";
import "dotenv/config";

if (!process.env.OPENAI_API_KEY) {
  console.error("Нет OPENAI_API_KEY в .env — скопируйте .env.example в .env и впишите ключ.");
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Всё, что ниже, можно переопределить через .env, не залезая в код.
const MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2";
const TRANSCRIBE_MODEL = process.env.REALTIME_TRANSCRIBE_MODEL || "gpt-realtime-whisper";
const DEFAULT_VOICE = process.env.REALTIME_VOICE || "marin";
// Как ассистент чувствует конец реплики: low — ждёт дольше и не перебивает.
const EAGERNESS = process.env.REALTIME_EAGERNESS || "low";
const SPEED = Number(process.env.REALTIME_SPEED || "0.95");
const MAX_OUTPUT_TOKENS = Number(process.env.REALTIME_MAX_OUTPUT_TOKENS || "400");

// Разрешённые голоса. Из этого же списка страница строит выпадающий список,
// и по нему же проверяется значение, пришедшее от браузера.
const VOICES = ["marin", "cedar", "verse", "alloy", "ash", "ballad", "coral", "sage", "echo", "shimmer"];

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

// Пресеты характера. Ключ приходит из выпадающего списка на странице.
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

// Единый источник списков для интерфейса — чтобы не дублировать их в браузере.
app.get("/config", (_req, res) => {
  res.json({
    voices: VOICES,
    characters: Object.entries(CHARACTERS).map(([key, c]) => ({ key, label: c.label })),
    defaults: { voice: DEFAULT_VOICE, character: DEFAULT_CHARACTER },
  });
});

/**
 * Простой лимит на выдачу сессий: без него любой, кто открыл хост,
 * может дёргать /session и жечь квоту OpenAI. Держим окно в памяти
 * по IP — для одного инстанса этого достаточно.
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
 * Браузеру нельзя давать настоящий API-ключ.
 * Сервер меняет свой постоянный ключ на короткоживущий client_secret,
 * с которым браузер уже сам соединяется с OpenAI напрямую.
 * Голос и характер приходят из выпадающих списков на странице —
 * значения проверяем по белым спискам, чужое не пропускаем.
 */
app.post("/session", async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Открой http://localhost:${PORT}`);
});
