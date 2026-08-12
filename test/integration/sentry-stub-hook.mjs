import { registerHooks } from "node:module";

const sentryStubUrl = `data:text/javascript,${encodeURIComponent(`
export function init() {}
export function captureException() {}
export function withScope(callback) {
  callback({ setTag() {} });
}
export async function flush() {
  return true;
}
`)}`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@sentry/node") {
			return { url: sentryStubUrl, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
