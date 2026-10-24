export interface MailEnv {
  RESEND_API_KEY?: string;
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(env: MailEnv, input: SendEmailInput): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  const body: Record<string, string> = { from: input.from, to: input.to, subject: input.subject, html: input.html };
  if (input.text !== undefined) {
    body.text = input.text;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`resend ${res.status}: ${await res.text()}`);
  }
}
