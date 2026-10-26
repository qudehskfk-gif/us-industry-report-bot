export const SOURCE_NAMES = {
  hankyung: "한경 컨센서스", naver: "네이버 금융", hana: "하나증권",
  mirae: "미래에셋증권", toss: "토스증권", kyobo: "교보증권",
  yuanta: "유안타증권", sangsang: "상상인증권", hyundai: "현대차증권", hanyang: "한양증권",
  kiwoom: "키움증권 공개채널", meritz: "메리츠증권 공개채널", korea: "한국투자증권 공개채널",
  samsung: "삼성증권 공개채널", sk: "SK증권 공개채널", nh: "NH투자증권 공개채널",
  shinhan: "신한투자증권 공개채널",
} as const;
export type Source = keyof typeof SOURCE_NAMES;
// New retrieval paths are supported before they are enabled in production.
// Activate only after the public list and full PDF have passed a runner check.
export const DEFAULT_SOURCES: Source[] = ["hankyung", "naver", "hana", "mirae", "toss", "kyobo", "yuanta", "sangsang", "hyundai", "hanyang"];
export function configuredSources(value = process.env.INDUSTRY_SOURCES): Source[] {
  const names = value === undefined ? DEFAULT_SOURCES : [...new Set(value.split(",").map(s => s.trim()))];
  if (!names.length || names.some(s => !Object.hasOwn(SOURCE_NAMES, s))) {
    throw new Error(`INDUSTRY_SOURCES 지원 출처: ${Object.keys(SOURCE_NAMES).join(",")}`);
  }
  return names as Source[];
}
