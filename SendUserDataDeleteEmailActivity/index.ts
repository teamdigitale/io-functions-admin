import * as HtmlToText from "html-to-text";
import { getMailerTransporter } from "io-functions-commons/dist/src/mailer";
import { getConfigOrThrow } from "../utils/config";
import { getActivityFunction } from "./handler";

const config = getConfigOrThrow();

// default sender for email
const MAIL_FROM = config.MAIL_FROM;

const HTML_TO_TEXT_OPTIONS: HtmlToText.HtmlToTextOptions = {
  ignoreImage: true, // ignore all document images
  tables: true
};

const mailerTransporter = getMailerTransporter(config);

const index = getActivityFunction(mailerTransporter, {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  HTML_TO_TEXT_OPTIONS,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  MAIL_FROM
});

export default index;
