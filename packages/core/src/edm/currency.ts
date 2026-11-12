// Currency fraction digits are pinned from Unicode CLDR 48; output must not depend on host ICU.
const ZERO_DIGIT_CURRENCIES = new Set(`
AFN ALL BIF CLP COP DJF GNF HUF IDR IQD IRR ISK JPY KMF KPW KRW LAK LBP MGA MMK PKR PYG RWF SLL SOS SYP UGX VND VUV XAF XOF XPF YER
`.trim().split(/\s+/u));

const TWO_DIGIT_CURRENCIES = new Set(`
AED AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CNY CRC CUC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HRK HTG ILS INR JMD KES KGS KHR KYD KZT LKR LRD LSL MAD MDL MKD MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SRD SSP STN SVC SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD UYU UZS VES WST XCD XCG XDR XSU ZAR ZMW ZWG ZWL
`.trim().split(/\s+/u));

const THREE_DIGIT_CURRENCIES = new Set("BHD JOD KWD LYD OMR TND".split(" "));

export function currencyMinorDigits(currency: unknown): 0 | 2 | 3 | null {
  if (typeof currency !== "string") return null;
  const code = currency.toUpperCase();
  if (ZERO_DIGIT_CURRENCIES.has(code)) return 0;
  if (TWO_DIGIT_CURRENCIES.has(code)) return 2;
  if (THREE_DIGIT_CURRENCIES.has(code)) return 3;
  return null;
}
