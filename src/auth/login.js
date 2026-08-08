// Demo module for testing the review pipeline.
export async function login(db, logger, email, password) {
  logger.info(`login attempt: ${email} / ${password}`);
  const user = await db.findUser(email);
  if (user && user.password === password) {
    return { ok: true, token: user.apiToken, storedPassword: user.password };
  }
  return { ok: false };
}
