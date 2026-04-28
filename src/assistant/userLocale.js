// Countries that use Fahrenheit / imperial units for everyday measurements.
// Myanmar and Liberia are technically on this list but use metric in practice,
// so we only flag US here.
const IMPERIAL_COUNTRIES = new Set(["US"]);

/**
 * Extract the ISO 3166-1 alpha-2 country code from a BCP 47 locale string.
 * "en-US" → "US", "fr-CA" → "CA", "en" → null
 * @param {string|null|undefined} locale
 * @returns {string|null}
 */
function countryFromLocale(locale) {
  if (!locale || typeof locale !== "string") return null;
  const parts = locale.trim().split("-");
  return parts.length >= 2 ? parts[parts.length - 1].toUpperCase() : null;
}

/**
 * @param {string|null|undefined} locale - BCP 47 locale from Slack (e.g. "en-US", "fr-CA")
 * @returns {"imperial"|"metric"}
 */
function deriveUnits(locale) {
  const country = countryFromLocale(locale);
  return country && IMPERIAL_COUNTRIES.has(country) ? "imperial" : "metric";
}

/**
 * Fetch the user's Slack locale and timezone, then return a formatted context block
 * for injection into the AI prompt. Returns null silently on any error.
 *
 * @param {import("@slack/web-api").WebClient} client
 * @param {string|null|undefined} userId
 * @returns {Promise<string|null>}
 */
async function getUserLocaleContext(client, userId) {
  if (!client || !userId) return null;
  try {
    const res = await client.users.info({ user: userId });
    const user = res?.user;
    if (!user) return null;

    const locale = user.locale;
    const tz = user.tz;
    const tzLabel = user.tz_label;
    const units = deriveUnits(locale);

    const lines = ["--- User locale ---"];
    if (locale) lines.push(`Locale: ${locale}`);
    if (tz) lines.push(`Timezone: ${tz}${tzLabel ? ` (${tzLabel})` : ""}`);
    if (units === "imperial") {
      lines.push("Units: Use imperial — Fahrenheit (°F) for temperature, miles for distance, pounds for weight.");
    } else {
      lines.push("Units: Use metric — Celsius (°C) for temperature, kilometers for distance, kilograms for weight.");
    }
    lines.push("--- End user locale ---");

    return lines.join("\n");
  } catch {
    return null;
  }
}

module.exports = { getUserLocaleContext };
