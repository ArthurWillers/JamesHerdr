// Thin i18n client — reads the active dictionary published by james-chrome via shared().
import { shared } from "herdr";

const FALLBACK_LANGS = [
  { code: "auto", name: "Auto (System)", englishName: "Follow system language" },
  { code: "en", name: "English", englishName: "English" },
];

export function supportedLangs() {
  return shared("james.i18n.langs") ?? FALLBACK_LANGS;
}

export function currentLang() {
  return shared("james.i18n.lang") ?? "en";
}

export function tr(key, vars = null) {
  const dict = shared("james.i18n.dict");
  let text = (dict && dict[key]) ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v ?? ""));
    }
  }
  return text;
}
