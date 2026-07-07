/**
 * grade.js — Lead Engine A–F scoring.
 *
 * computeGrade(lead) -> { grade, score }
 *
 * Scoring (all additive):
 *   Price (lower is better): no/zero price 1; <=10k 10; 10k-20k 8;
 *     20k-30k 6; 30k-40k 4; 40k-50k 2; >50k 0.
 *   Days on market: >=180 8; 90-179 6; 60-89 4; 30-59 3; 14-29 2; 1-13 1; 0/blank 0.
 *   FSBO bonus: +4.
 *   Keyword strength: distinct matches among GRADE_KEYWORDS — 1=>2, 2=>4, 3=>6.
 *   Price drop: +3 when the Price Change text shows new < old.
 *   Has contact: +1 if any of agentPhone/agentEmail/fsboPhone/fsboEmail.
 *
 * Grade: A >=22; B 17-21; C 12-16; D 7-11; E 3-6; F 0-2.
 */
'use strict';

const GRADE_KEYWORDS = ['seller financing', 'land contract', 'contract for deed'];

function scorePrice(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 1; // no price
  if (p <= 10000) return 10;
  if (p <= 20000) return 8;
  if (p <= 30000) return 6;
  if (p <= 40000) return 4;
  if (p <= 50000) return 2;
  return 0;
}

function scoreDaysOnMarket(dom) {
  const n = Number(dom);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 / blank
  if (n >= 180) return 8;
  if (n >= 90) return 6;
  if (n >= 60) return 4;
  if (n >= 30) return 3;
  if (n >= 14) return 2;
  return 1; // 1-13
}

function scoreKeywords(keywords) {
  const s = String(keywords || '').toLowerCase();
  let hits = 0;
  for (const k of GRADE_KEYWORDS) {
    if (s.indexOf(k) !== -1) hits++;
  }
  return hits * 2; // 0 / 2 / 4 / 6
}

/**
 * isPriceDrop("$42000 -> $22500 ...") — parse the first two prices out of
 * the Price Change text; true when the newer number is lower. Parenthesized
 * notes and date-like tokens (7/2/2026) are stripped first so they never
 * masquerade as prices.
 */
function isPriceDrop(priceChanges) {
  let s = String(priceChanges || '');
  if (!s.trim()) return false;
  s = s.replace(/\([^)]*\)/g, ' ');                   // drop "(price updated ...)" notes
  s = s.replace(/\d{1,4}\/\d{1,2}\/\d{1,4}/g, ' ');   // drop date-like tokens
  s = s.replace(/,/g, '');                            // 42,000 -> 42000
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return false;
  const oldPrice = Number(nums[0]);
  const newPrice = Number(nums[1]);
  return Number.isFinite(oldPrice) && Number.isFinite(newPrice) && newPrice < oldPrice;
}

function hasContact(lead) {
  const fields = [lead.agentPhone, lead.agentEmail, lead.fsboPhone, lead.fsboEmail];
  return fields.some((v) => v !== undefined && v !== null && String(v).trim() !== '');
}

function toGrade(score) {
  if (score >= 22) return 'A';
  if (score >= 17) return 'B';
  if (score >= 12) return 'C';
  if (score >= 7) return 'D';
  if (score >= 3) return 'E';
  return 'F';
}

/** computeGrade(lead) -> { grade: 'A'..'F', score: number } */
function computeGrade(lead) {
  const l = lead || {};
  let score = 0;
  score += scorePrice(l.price);
  score += scoreDaysOnMarket(l.daysOnMarket);
  if (l.isFsbo === 1 || l.isFsbo === true || l.isFsbo === '1') score += 4;
  score += scoreKeywords(l.keywords);
  if (isPriceDrop(l.priceChanges)) score += 3;
  if (hasContact(l)) score += 1;
  return { grade: toGrade(score), score };
}

module.exports = { computeGrade, isPriceDrop, GRADE_KEYWORDS };
