const DEFAULT_LENGTH = 3;
const TURN_TIME_LIMITS = [15, 30, 45, 60, 0];
const DEFAULT_TURN_TIME_LIMIT = 30;

function normalizeKeyword(input) {
  return String(input || "").normalize("NFKC").trim().toLocaleLowerCase("ja-JP");
}

function validateKeyword(input) {
  const keyword = normalizeKeyword(input);
  if (Array.from(keyword).length < 4) {
    return { ok: false, message: "キーワードは4文字以上にしてください。" };
  }
  return { ok: true, value: keyword };
}

function validateNumber(value, length = DEFAULT_LENGTH) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) {
    return { ok: false, message: "数字だけで入力してください。" };
  }
  if (text.length !== length) {
    return { ok: false, message: `${length}桁で入力してください。` };
  }
  if (new Set(text).size !== text.length) {
    return { ok: false, message: "同じ数字は使えません。" };
  }
  return { ok: true, value: text };
}

function validateTimeLimit(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return { ok: false, message: "制限時間を選んでください。" };
  }
  const limit = Number(value);
  if (!TURN_TIME_LIMITS.includes(limit)) {
    return {
      ok: false,
      message: "制限時間は15秒・30秒・45秒・60秒・無制限から選んでください。"
    };
  }
  return { ok: true, value: limit };
}

function judgeGuess(guess, secret) {
  let hits = 0;
  let blows = 0;

  for (let index = 0; index < guess.length; index += 1) {
    if (guess[index] === secret[index]) {
      hits += 1;
    } else if (secret.includes(guess[index])) {
      blows += 1;
    }
  }

  return { hits, blows };
}

module.exports = {
  DEFAULT_TURN_TIME_LIMIT,
  DEFAULT_LENGTH,
  TURN_TIME_LIMITS,
  judgeGuess,
  normalizeKeyword,
  validateKeyword,
  validateNumber,
  validateTimeLimit
};
