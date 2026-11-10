// Location names in plain words (glossary: say "US East (N. Virginia)", not
// "us-east-1"). The code appears only in Details and the CLI footer.
//
// AWS's own console names. A region missing here is shown by its code under
// Details only; `regionName()` returns undefined so the caller can say
// "an unnamed location" instead of leaking the code into body copy.

const NAMES: Record<string, string> = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "ca-central-1": "Canada (Central)",
  "eu-west-1": "Europe (Ireland)",
  "eu-west-2": "Europe (London)",
  "eu-central-1": "Europe (Frankfurt)",
  "eu-north-1": "Europe (Stockholm)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "sa-east-1": "South America (São Paulo)",
};

export function regionName(code: string): string | undefined {
  return NAMES[code];
}

export function knownRegions(): string[] {
  return Object.keys(NAMES);
}
