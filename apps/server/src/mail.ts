import nodemailer from "nodemailer";
import type { Config } from "./config";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** SMTP mailer from SMTP_URL, or undefined when email is not configured. */
export function createMailer(config: Config): Mailer | undefined {
  if (!config.smtpUrl) return undefined;
  const transport = nodemailer.createTransport(config.smtpUrl);
  return {
    send: async (mail) => {
      await transport.sendMail({ from: config.mailFrom, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

/*
 * Plain-text emails. Getman is a desktop app, so emails carry codes to type
 * in the app instead of links.
 */
export const templates = {
  verify: (code: string): Omit<Mail, "to"> => ({
    subject: `Your Getman verification code: ${code}`,
    text: `Enter this code in Getman (Account → Verify email) to confirm your email address:\n\n    ${code}\n\nThe code expires in 30 minutes. If you did not create a Getman account, ignore this email.\n`,
  }),
  reset: (code: string): Omit<Mail, "to"> => ({
    subject: "Reset your Getman password",
    text: `Someone asked to reset the password of your Getman account.\n\nEnter this code in Getman (Sign in → Forgot password?):\n\n    ${code}\n\nThe code expires in 30 minutes and works once. Resetting signs you out everywhere.\nIf you did not ask for this, ignore this email; your password does not change.\n`,
  }),
  invite: (p: { inviter: string; workspace: string; role: string; code: string; serverUrl: string }): Omit<Mail, "to"> => ({
    subject: `${p.inviter} invited you to "${p.workspace}" on Getman`,
    text: `${p.inviter} invited you to the Getman workspace "${p.workspace}" as ${p.role}.\n\n1. Install Getman (https://github.com/ruanrita/getman) and open it.\n2. Sign in → server ${p.serverUrl} → create an account with this email address (or sign in).\n3. Verify your email, or enter this invite code under Account → Have an invite code?\n\n    ${p.code}\n\nThe invitation expires in 7 days.\n`,
  }),
};
