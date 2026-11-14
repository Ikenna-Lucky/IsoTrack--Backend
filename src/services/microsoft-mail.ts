import { PublicClientApplication } from "@azure/msal-node";
import type {
  INetworkModule,
  NetworkRequestOptions,
  NetworkResponse,
} from "@azure/msal-node";
import { microsoftMailConfig } from "../lib/microsoft-mail-config.ts";
import {
  createMailCacheStore,
  type MailCacheDatabase,
} from "../db/mail-cache-store.ts";
import { createGraphEmailSender } from "../lib/graph-email.ts";
const scopes = ["https://graph.microsoft.com/Mail.Send"];
// Bound Microsoft discovery/token calls without logging credentials or provider bodies.
const network: INetworkModule = {
  sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions) =>
    networkRequest<T>(url, options),
  sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) =>
    networkRequest<T>(url, options, true),
};
async function networkRequest<T>(
  url: string,
  options?: NetworkRequestOptions,
  post = false,
): Promise<NetworkResponse<T>> {
  const response = await fetch(url, {
    method: post ? "POST" : "GET",
    headers: options?.headers ?? {},
    ...(post && options?.body ? { body: options.body } : {}),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  return {
    headers: Object.fromEntries(response.headers),
    status: response.status,
    body: (await response.json()) as T,
  };
}
const microsoftApplication = (clientId: string) =>
  new PublicClientApplication({
    auth: {
      clientId,
      authority: "https://login.microsoftonline.com/consumers",
    },
    system: {
      networkClient: network,
      loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false },
    },
  });
type MailApplication = Pick<
  PublicClientApplication,
  "getTokenCache" | "acquireTokenSilent" | "acquireTokenByDeviceCode"
>;
export function createMicrosoftMail(
  config: Record<string, unknown>,
  database: MailCacheDatabase,
  createApplication: (
    clientId: string,
  ) => MailApplication = microsoftApplication,
) {
  const settings = microsoftMailConfig(config);
  const sender = settings.MICROSOFT_MAIL_SENDER.toLowerCase();
  const store = createMailCacheStore(
    database,
    settings.MICROSOFT_MAIL_CLIENT_ID + ":" + sender,
    settings.MICROSOFT_MAIL_CACHE_KEY,
  );
  let cached: { token: string; until: number } | null = null;
  let pending: Promise<string> | null = null;
  const application = () =>
    createApplication(settings.MICROSOFT_MAIL_CLIENT_ID);
  const token = (forceRefresh = false): Promise<string> => {
    if (!forceRefresh && cached && cached.until > Date.now() + 60000)
      return Promise.resolve(cached.token);
    if (pending) return pending;
    pending = store
      .use(async (serialized) => {
        if (!serialized)
          throw new Error(
            "Authorize the Outlook sender before enabling email workers.",
          );
        const app = application();
        app.getTokenCache().deserialize(serialized);
        const accounts = await app.getTokenCache().getAllAccounts();
        const account = accounts.find(
          (value) => value.username.toLowerCase() === sender,
        );
        if (!account)
          throw new Error(
            "Authorized Outlook account does not match configured sender.",
          );
        const result = await app.acquireTokenSilent({
          account,
          scopes,
          forceRefresh,
        });
        if (!result?.accessToken || !result.expiresOn)
          throw new Error("Outlook authorization must be renewed.");
        return {
          cache: app.getTokenCache().serialize(),
          value: {
            token: result.accessToken,
            until: result.expiresOn.getTime(),
          },
        };
      })
      .then((result) => {
        cached = result;
        return result.token;
      })
      .catch(() => {
        cached = null;
        throw new Error(
          "Outlook authorization unavailable. Check configuration or authorize the sender again.",
        );
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return {
    send: createGraphEmailSender(token),
    authorize: (showCode: (message: string) => void) =>
      store.use(async () => {
        const app = application();
        const result = await app.acquireTokenByDeviceCode({
          scopes,
          deviceCodeCallback: (response) => showCode(response.message),
        });
        if (
          !result?.account ||
          result.account.username.toLowerCase() !== sender
        )
          throw new Error("Sign in with the configured Outlook sender.");
        cached = null;
        return { cache: app.getTokenCache().serialize(), value: undefined };
      }, 1200),
  };
}
