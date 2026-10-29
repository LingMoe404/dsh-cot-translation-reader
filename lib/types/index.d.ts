import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
/**
 * Host half. The official COT bundle provides `cotTranslation` on the Host
 * only — its browser half never exposes that name, so the reading view cannot
 * reach it directly. This half registers two same-origin routes the browser
 * half calls instead: one reads routing without sending text, one translates.
 */
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer?: {
            register: (route: {
                kind: 'exact' | 'prefix';
                path: string;
                handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
            }) => () => void;
        };
    }
}
export declare const name = "cot-translation-reader";
/** Routes exist only while the Host is mounted, so wait for the web server. */
export declare const inject: string[];
/**
 * Register the translation routes.
 *
 * @param ctx - Host plugin context.
 * @returns disposer removing both routes.
 */
export declare function apply(ctx: Context): () => void;
//# sourceMappingURL=index.d.ts.map