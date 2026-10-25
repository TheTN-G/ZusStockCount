export * from "./generated/api";
export * from "./generated/api.schemas";
export {
  setActiveStoreroomId,
  setActiveOutletId,
  setBaseUrl,
  setAuthTokenGetter,
} from "./custom-fetch";
export type { AuthTokenGetter } from "./custom-fetch";
