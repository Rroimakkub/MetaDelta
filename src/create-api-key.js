import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const baseUrl = (process.env.DELTAFORCE_API_BASE_URL ?? 'https://api.deltaforceapi.com').replace(/\/$/, '');
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');

async function callAuth(method, body, headers = {}) {
  const response = await fetch(`${baseUrl}/deltaforceapi.gateway.AuthService/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = data.details?.flatMap((detail) => detail.debug?.fieldViolations ?? []).map((v) => `${v.field} ${v.description}`) ?? [];
    throw new Error(`${method} failed (HTTP ${response.status}): ${data.message ?? 'unknown error'}${details.length ? ` — ${details.join(', ')}` : ''}`);
  }
  return data;
}

async function saveToken(token) {
  let text = '';
  try {
    text = await readFile(envFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const line = `DELTAFORCE_API_TOKEN=${token}`;
  text = /^DELTAFORCE_API_TOKEN=.*$/m.test(text) ? text.replace(/^DELTAFORCE_API_TOKEN=.*$/m, line) : `${text.trimEnd()}\n${line}\n`;
  await writeFile(envFile, text, 'utf8');
}

const rl = createInterface({ input, output });
const lines = rl[Symbol.asyncIterator]();

async function ask(question) {
  output.write(question);
  const { value, done } = await lines.next();
  if (done) throw new Error('Input ended before all answers were given.');
  return value.trim();
}

try {
  console.log('สร้าง API key ของ DeltaForceAPI\n');
  const choice = await ask('1) สมัครผู้ใช้ใหม่  2) มีผู้ใช้แล้ว  เลือก [1/2]: ');
  const username = await ask('ชื่อผู้ใช้ (username): ');

  if (choice !== '2') {
    const { rawTotpSecret } = await callAuth('CreateUser', { username });
    const uri = `otpauth://totp/DeltaForceAPI:${encodeURIComponent(username)}?secret=${rawTotpSecret}&issuer=DeltaForceAPI`;
    console.log('\nสมัครสำเร็จ รหัสลับ TOTP ของคุณคือ:\n');
    console.log(`  ${rawTotpSecret}\n`);
    console.log('1. เปิดแอป Google Authenticator (หรือแอป Authenticator อื่น) → + → "Enter a setup key"');
    console.log(`2. Account name: ${username}  Key: รหัสด้านบน  Type: Time based`);
    console.log('3. จดรหัสลับนี้เก็บไว้ที่ปลอดภัย จะดูอีกไม่ได้ และต้องใช้ทุกครั้งที่สร้างหรือลบ key');
    console.log(`\n(ถ้าแอปรองรับ ใช้ลิงก์นี้แทนได้: ${uri})\n`);
  }

  let code = '';
  while (!/^\d{6}$/.test(code)) code = await ask('ใส่รหัส 6 หลักจากแอป Authenticator: ');

  const { rawApiKey } = await callAuth(
    'CreateApiKey',
    { name: 'MetaDeltaBot', keyType: 'API_KEY_TYPE_SERVER_TO_SERVER' },
    { 'deltaforceapi-gateway-username': username, 'deltaforceapi-gateway-totp-code': code },
  );
  if (!rawApiKey) throw new Error('CreateApiKey returned no key.');
  await saveToken(rawApiKey);
  console.log(`\nสร้าง key สำเร็จ (${rawApiKey.slice(0, 4)}…${rawApiKey.slice(-4)}) และบันทึกลง .env เป็น DELTAFORCE_API_TOKEN แล้ว`);
  console.log('ตั้ง DEMO_MODE=false ใน .env แล้วรัน npm run check-crafts เพื่อทดสอบ');
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
