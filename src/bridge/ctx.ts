/** Everything decided by tode before the generated extension starts.
 * JSON only: bridge.ts serializes this object into extension.js. */
export interface BridgeCtx {
  /** command used to call back into this tode installation */
  tode: string[];
  /** whole vscode theme document watched and applied to the open window */
  liveThemeFile: string;
  /** message shown when ctrl+c redirects to the actual quit chord */
  quitHint: string;
  /** one-shot marker written by `tode --review` */
  startupViewFile: string;
}
