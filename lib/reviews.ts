import type { ReviewCard, ReviewRating } from "./study.ts";

export function nextReviewDelay(card: Pick<ReviewCard, "intervalDays">, rating: ReviewRating): number {
  if (rating === "again") return 10 * 60_000;
  if (rating === "hard") return 86_400_000;
  return Math.min(60, Math.max(3, card.intervalDays * 2)) * 86_400_000;
}

export function reviewSummary(cards: ReviewCard[], now: number) {
  const attempts = cards.flatMap(card => card.attempts).filter(attempt => attempt.at >= now - 7 * 86_400_000 && attempt.at <= now);
  return {
    due: cards.filter(card => card.dueAt <= now).length,
    attempts: attempts.length,
    good: attempts.filter(attempt => attempt.rating === "good").length,
    needsPractice: cards.filter(card => {
      const latest = card.attempts.at(-1);
      return latest && latest.rating !== "good";
    }).length,
  };
}
