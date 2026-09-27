import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { token } from "@bun-hydrate/di";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** How the app sends mail. The transport (SMTP, an API) is the app's choice, not the framework's. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export const Mailer = token<Mailer>("Mailer");

/** Appends each mail to a JSON-lines file (OUTBOX_PATH): for development, tests and the e2e suite. */
export class LogMailer implements Mailer {
  constructor(private readonly path: string) {}

  async send(mail: Mail): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ ...mail, sentAt: new Date().toISOString() })}\n`);
  }
}
