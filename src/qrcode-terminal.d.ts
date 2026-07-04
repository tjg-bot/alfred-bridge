// Type declaration shim for qrcode-terminal (ships no types on npm).
// Only the two members we use are declared - everything else is any.
declare module "qrcode-terminal" {
  export function generate(
    text: string,
    opts?: { small?: boolean },
    cb?: (qrcode: string) => void
  ): void;
  const _default: {
    generate: typeof generate;
  };
  export default _default;
}
