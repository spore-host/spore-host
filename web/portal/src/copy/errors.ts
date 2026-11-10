// The shared error catalogue (brief §4 Flow E, §6 rule 5).
//
// Every failure the portal shows comes from here: what happened, the likely
// reason, and one thing to do, with the raw detail kept for "Details for
// support". Pages never print an AWS message or an HTTP status as the text.
//
// Parity: the brief asks for the CLI's text. The spawn CLI has no
// user-facing catalogue for these codes today (it prints AWS's own message
// via LaunchErrorDetail), so the wording here is the GUI's, written to the
// glossary. When spawn-ts exports error text as data (brief §9, Go vectors
// via #646), entries switch to it and the matrix gains rows for them.
//
// The AWS codes are the ones spawn classifies: capacityErrorCodes in
// spawn/pkg/aws/zone_fallback.go for capacity, and the standard IAM/STS codes.

export type ErrorKind =
  | "not-permitted"
  | "quota"
  | "capacity"
  | "signed-out"
  | "invalid-request"
  | "throttled"
  | "service-error"
  | "network"
  | "unknown";

export type ActionKind = "retry" | "sign-in" | "setup" | "quota-help" | "change-size" | "edit";

export interface CatalogueEntry {
  kind: ErrorKind;
  /** What happened. Shown as the error's title. */
  title: string;
  /** The likely reason, one or two short sentences. */
  cause: string;
  /** The one thing to do, rendered as a button. */
  action: { kind: ActionKind; label: string };
  /** AWS error codes (error.name / Code) that mean this. */
  codes: readonly string[];
}

export const CATALOGUE: Readonly<Record<ErrorKind, CatalogueEntry>> = {
  "not-permitted": {
    kind: "not-permitted",
    title: "Your AWS account isn't set up for this yet",
    cause: "Your account doesn't allow spore.host to do this. An administrator sets it up once from the command line.",
    action: { kind: "setup", label: "See what to set up" },
    codes: ["UnauthorizedOperation", "AccessDenied", "AccessDeniedException", "UnauthorizedAccess", "AuthorizationError"],
  },
  quota: {
    kind: "quota",
    title: "Your AWS account isn't approved for this size yet",
    cause: "AWS limits how many processors an account can run at once, and this would go over that limit.",
    action: { kind: "quota-help", label: "How to request more" },
    codes: ["VcpuLimitExceeded", "InstanceLimitExceeded"],
  },
  capacity: {
    kind: "capacity",
    title: "AWS has none of this size free right now",
    cause: "This location has no spare instances of this size at the moment. It often frees up later.",
    action: { kind: "change-size", label: "Try another size" },
    codes: ["InsufficientInstanceCapacity", "InsufficientHostCapacity", "MaxSpotInstanceCountExceeded", "SpotMaxPriceTooLow"],
  },
  "signed-out": {
    kind: "signed-out",
    title: "You've been signed out",
    cause: "Signing in lasts an hour at most, and yours has ended. Your instances keep running and keep costing money.",
    action: { kind: "sign-in", label: "Sign in again" },
    codes: ["ExpiredToken", "ExpiredTokenException", "RequestExpired", "InvalidClientTokenId", "UnrecognizedClientException"],
  },
  "invalid-request": {
    kind: "invalid-request",
    title: "AWS didn't accept that request",
    cause: "One of your choices isn't valid for this size or location.",
    action: { kind: "edit", label: "Check your choices" },
    codes: ["InvalidParameterValue", "InvalidParameterCombination", "InvalidParameter", "MissingParameter", "ValidationError", "ValidationException"],
  },
  throttled: {
    kind: "throttled",
    title: "AWS is busy",
    cause: "Too many requests reached AWS at once. Waiting a few seconds usually fixes it.",
    action: { kind: "retry", label: "Try again" },
    codes: ["RequestLimitExceeded", "Throttling", "ThrottlingException", "TooManyRequestsException"],
  },
  "service-error": {
    kind: "service-error",
    title: "AWS had a problem",
    cause: "This is on AWS's side and is usually brief.",
    action: { kind: "retry", label: "Try again" },
    codes: ["InternalError", "InternalFailure", "ServiceUnavailable", "Unavailable"],
  },
  network: {
    kind: "network",
    title: "We couldn't reach AWS",
    cause: "Your connection may have dropped, or a network filter may be blocking AWS.",
    action: { kind: "retry", label: "Try again" },
    codes: [],
  },
  unknown: {
    kind: "unknown",
    title: "Something went wrong",
    cause: "We don't recognise this error. The details below help support find out what happened.",
    action: { kind: "retry", label: "Try again" },
    codes: [],
  },
};

const BY_CODE = new Map<string, ErrorKind>(
  Object.values(CATALOGUE).flatMap((e) => e.codes.map((c) => [c, e.kind] as const)),
);

interface AwsLikeError {
  name?: unknown;
  Code?: unknown;
  code?: unknown;
  message?: unknown;
  $fault?: unknown;
  $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
}

function asObj(err: unknown): AwsLikeError {
  return typeof err === "object" && err !== null ? (err as AwsLikeError) : {};
}

/** The AWS error code, if the error carries one. */
export function errorCode(err: unknown): string | undefined {
  const e = asObj(err);
  for (const v of [e.Code, e.code, e.name]) if (typeof v === "string" && v && v !== "Error") return v;
  return undefined;
}

function status(err: unknown): number | undefined {
  const s = asObj(err).$metadata?.httpStatusCode;
  return typeof s === "number" ? s : undefined;
}

/** Which catalogue entry an error is. Order: known code, network failure, HTTP status, unknown. */
export function classify(err: unknown): ErrorKind {
  const code = errorCode(err);
  if (code && BY_CODE.has(code)) return BY_CODE.get(code)!;
  // fetch() rejects with a TypeError on a network failure in every browser.
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return "network";
  if (code === "NetworkError" || code === "TimeoutError") return "network";
  const s = status(err);
  if (s === 401) return "signed-out";
  if (s === 403) return "not-permitted";
  if (s === 429) return "throttled";
  if (s !== undefined && s >= 500) return "service-error";
  if (asObj(err).$fault === "server") return "service-error";
  return "unknown";
}

export function entryFor(err: unknown): CatalogueEntry {
  return CATALOGUE[classify(err)];
}

/**
 * The raw detail for "Details for support": code, HTTP status, request id and
 * AWS's message. Never the error object itself, which can carry request
 * headers. Credentials are never in these fields.
 */
export function supportDetails(err: unknown): string {
  const e = asObj(err);
  const lines: string[] = [];
  const code = errorCode(err);
  if (code) lines.push(`Code: ${code}`);
  const s = status(err);
  if (s !== undefined) lines.push(`HTTP status: ${s}`);
  const rid = e.$metadata?.requestId;
  if (typeof rid === "string" && rid) lines.push(`Request id: ${rid}`);
  const msg = err instanceof Error ? err.message : typeof e.message === "string" ? e.message : typeof err === "string" ? err : "";
  if (msg) lines.push(`Message: ${msg}`);
  return lines.length ? lines.join("\n") : "No further detail was returned.";
}
