import { createTransport, type Transporter } from "nodemailer";
import { config } from "./config";
import { log } from "./util";

export interface Mail { to: string[]; subject: string; text: string }
/** Outgoing mail status, for the admin page. Never includes addresses or message bodies. */
export interface MailHealth { lastOkAt: number | null; lastErrorAt: number | null }

/**
 * Sends email. `smtpMailer` is the real one (SMTP_URL); `MemoryMailer` keeps messages for tests.
 * `send` never throws: a failure is logged and recorded in `health()`, and the caller carries on.
 */
export interface Mailer {
  send(m: Mail): Promise<boolean>;
  health(): MailHealth;
}

abstract class Base implements Mailer {
  private h: MailHealth = { lastOkAt: null, lastErrorAt: null };
  protected abstract deliver(m: Mail): Promise<void>;
  async send(m: Mail) {
    try {
      await this.deliver(m);
      this.h.lastOkAt = Date.now();
      return true;
    } catch (e) {
      this.h.lastErrorAt = Date.now();
      log("error", "email could not be sent", { error: (e as Error).message?.slice(0, 300) });
      return false;
    }
  }
  health() { return { ...this.h }; }
}

class SmtpMailer extends Base {
  private t: Transporter | undefined;
  protected async deliver(m: Mail) {
    const c = config();
    if (!c.SMTP_URL || !c.MAIL_FROM) throw new Error("outgoing mail is not set up");
    this.t ??= createTransport(c.SMTP_URL, { from: c.MAIL_FROM });
    await this.t.sendMail({ to: m.to, subject: m.subject, text: m.text });
  }
}
export const smtpMailer = (): Mailer => new SmtpMailer();

export class MemoryMailer extends Base {
  sent: Mail[] = [];
  fail = false;
  protected async deliver(m: Mail) {
    if (this.fail) throw new Error("simulated mail failure");
    this.sent.push(m);
  }
}
