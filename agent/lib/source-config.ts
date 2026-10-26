export const SOURCE_NAMES = {
  hankyung: "한경 컨센서스", naver: "네이버 금융", hana: "하나증권",
  mirae: "미래에셋증권", toss: "토스증권", kyobo: "교보증권",
  yuanta: "유안타증권", sangsang: "상상인증권", hyundai: "현대차증권", hanyang: "한양증권",
} as const;
export type Source = keyof typeof SOURCE_NAMES;
export const DEFAULT_SOURCES = Object.keys(SOURCE_NAMES) as Source[];
export function configuredSources(value = process.env.INDUSTRY_SOURCES): Source[] {
  const names = value === undefined ? DEFAULT_SOURCES : [...new Set(value.split(",").map(s => s.trim()))];
  if (!names.length || names.some(s => !Object.hasOwn(SOURCE_NAMES, s))) {
    throw new Error(`INDUSTRY_SOURCES 지원 출처: ${DEFAULT_SOURCES.join(",")}`);
  }
  return names as Source[];
}
