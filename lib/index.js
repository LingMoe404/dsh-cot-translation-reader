// src/index.ts
/**
* Host entry. The contribution is browser-side only: the reading view seam is
* applied in `src/client/index.ts`, so nothing runs on the Host beyond this
* module being loaded and mounting.
*/
const name = "cot-translation-reader";
/** No Host services, routes, or tools. */
function apply(_ctx) {}
export { apply, name };
