export type IntentSpec = Readonly<{
  metrics: readonly string[];
  groupings: readonly string[];
  startDate?: Date;
  endDate?: Date;
  filters: readonly string[];
  confirmedBy?: string;
  confirmedAt?: string;
}>;

export type MissingSlot = Readonly<{
  slot: "metrics" | "period" | "confirmation";
  message: string;
}>;

export function validateIntentSpec(spec: IntentSpec): MissingSlot[] {
  const missing: MissingSlot[] = [];

  if (spec.metrics.length === 0) {
    missing.push({ slot: "metrics", message: "조회할 지표 또는 컬럼을 지정해야 합니다." });
  }

  if (spec.startDate === undefined || spec.endDate === undefined) {
    missing.push({ slot: "period", message: "조회 기간의 시작일과 종료일을 모두 지정해야 합니다." });
  } else if (spec.startDate.getTime() > spec.endDate.getTime()) {
    missing.push({ slot: "period", message: "조회 시작일은 종료일보다 늦을 수 없습니다." });
  }

  if (spec.confirmedBy === undefined || spec.confirmedAt === undefined) {
    missing.push({ slot: "confirmation", message: "요청자의 실행 전 확인이 필요합니다." });
  }

  return missing;
}
