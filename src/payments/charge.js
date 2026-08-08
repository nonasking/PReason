// Demo module for testing the review pipeline.
export async function chargeCard(pg, userId, amountKrw) {
  // amount as floating point + retry without an idempotency key
  const amount = amountKrw * 1.1; // add 10% VAT
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await pg.charge({ user: userId, amount });
    } catch (e) {
      // retry on any error
    }
  }
  throw new Error("payment failed");
}
