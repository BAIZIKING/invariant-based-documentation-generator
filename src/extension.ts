// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeConfig, backend } from './backend';

// Key under which the Anthropic API key is stored in VS Code's SecretStorage.
// SecretStorage keeps the key encrypted and out of settings.json (which is plain
// text and may sync across machines).
const API_KEY_SECRET = 'invariant-based-documentation-generator.apiKey';

// This method is called when your extension is activated
// Your extension is activated as soon as a Python file is opened (see activationEvents in package.json)
export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(
		vscode.commands.registerCommand('invariant-based-documentation-generator.generator', (functionCode: string = '') => {
			const panel = vscode.window.createWebviewPanel('IBDGenerator', 'Invariant-Based Documentation Generator', vscode.ViewColumn.Beside, {
				enableScripts: true,
				retainContextWhenHidden: true,
				// Allow the webview to load the bundled libraries and our media assets via asWebviewUri.
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'marked'),
					vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'dompurify'),
					vscode.Uri.joinPath(context.extensionUri, 'media')
				]
			});
			panel.webview.html = getWebViewContent(functionCode, panel.webview, context.extensionUri);

			// Server-side conversation state for this panel: the invariants step
			// produces a chat history that the PBT step continues from. Scoped to
			// the panel's closure, so each panel keeps its own conversation.
			let conversation: Anthropic.MessageParam[] = [];

			panel.webview.onDidReceiveMessage(async (message) => {
				// Run a single generated property-based test: combine the source under
				// test with the test function, execute it with Python, and report back
				// to the webview keyed by the test's id.
				if (message?.type === 'run-test') {
					try {
						const { ok, output } = await runPythonTest(message.code, message.test);
						panel.webview.postMessage({ type: 'test-result', id: message.id, ok, output });
					} catch (err) {
						const detail = err instanceof Error ? err.message : String(err);
						panel.webview.postMessage({ type: 'test-result', id: message.id, ok: false, output: detail });
					}
					return;
				}
				if (message?.type !== 'generate') {
					return;
				}
				const step = message.step;
				const config = await resolveClaudeConfig(context);
				if (!config) {
					panel.webview.postMessage({ type: 'result', step, ok: false, text: 'No Anthropic API key is set.' });
					return;
				}
				try {
					let text: string;
					if (step === 'invariants') {
						// Start (or restart) the conversation and remember its history
						// so the PBT step can continue from it.
						const result = await backend.query_invariants(message.code, config);
						conversation = result.messages;
						text = result.text;
					} else if (step === 'pbt') {
						// Continue the invariants conversation captured above.
						const invariants = parseInvariants(message.invariants);
						const result = await backend.query_test_cases(invariants, conversation, config);
						text = result.text;
					} else if (step === 'documentation') {
						const invariants = parseInvariants(message.invariants);
						text = await backend.query_documentation(message.code, invariants, config);
					} else {
						return;
					}
					panel.webview.postMessage({ type: 'result', step, ok: true, text });
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					panel.webview.postMessage({ type: 'result', step, ok: false, text: `Error: ${detail}` });
				}
			}, undefined, context.subscriptions);

			panel.onDidDispose(() => {}, null, context.subscriptions);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('invariant-based-documentation-generator.setApiKey', async () => {
			const apiKey = await vscode.window.showInputBox({
				title: 'Anthropic API Key',
				prompt: 'Enter your Anthropic API key (sk-ant-...).',
				placeHolder: 'sk-ant-...',
				password: true,
				ignoreFocusOut: true
			});
			if (apiKey === undefined) {
				return; // user cancelled
			}
			const trimmed = apiKey.trim();
			if (trimmed === '') {
				await context.secrets.delete(API_KEY_SECRET);
				vscode.window.showInformationMessage('Anthropic API key cleared.');
				return;
			}
			await context.secrets.store(API_KEY_SECRET, trimmed);
			vscode.window.showInformationMessage('Anthropic API key saved.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('invariant-based-documentation-generator.clearApiKey', async () => {
			await context.secrets.delete(API_KEY_SECRET);
			vscode.window.showInformationMessage('Anthropic API key cleared.');
		})
	);

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ language: 'python' }, new PythonFunctionCodeLensProvider())
	);
}

// The prompt asks for raw JSON with no markdown, but models sometimes still
// wrap their reply in a ```json ... ``` code fence. Strip a surrounding fence
// (with or without a language tag) so JSON.parse sees just the JSON.
function stripJsonFence(raw: string): string {
	return raw
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '')
		.trim();
}

// query_invariants returns a JSON array of objects shaped like
// {"invariant": "...", "lineno": 10, "end_lineno": 14}. The PBT and
// documentation steps only need the invariant text, not the line numbers, so
// extract just the "invariant" strings.
function parseInvariants(raw: string): string[] {
	const parsed = JSON.parse(stripJsonFence(raw));
	return parsed.map((item: { invariant: string }) => item.invariant);
}

// Resolves the configuration the backend needs: the model from settings and the
// API key from SecretStorage (falling back to the ANTHROPIC_API_KEY environment
// variable). Returns undefined and prompts the user when no key is available.
export async function resolveClaudeConfig(context: vscode.ExtensionContext): Promise<ClaudeConfig | undefined> {
	const model = vscode.workspace
		.getConfiguration('invariant-based-documentation-generator')
		.get<string>('model', 'claude-opus-4-8');

	const apiKey = (await context.secrets.get(API_KEY_SECRET)) ?? process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		const choice = await vscode.window.showErrorMessage(
			'No Anthropic API key is set. Set one to generate invariants.',
			'Set API Key'
		);
		if (choice === 'Set API Key') {
			await vscode.commands.executeCommand('invariant-based-documentation-generator.setApiKey');
		}
		return undefined;
	}

	return { apiKey, model };
}

// Resolves the Python interpreter to run the generated tests with. Prefers the
// interpreter the user has selected in the Microsoft Python extension (so it
// matches the environment where hypothesis is installed); falls back to a bare
// `python`/`python3` on the PATH when that extension isn't available.
async function resolvePythonCommand(): Promise<string> {
	const ext = vscode.extensions.getExtension('ms-python.python');
	if (ext) {
		try {
			if (!ext.isActive) {
				await ext.activate();
			}
			const api = ext.exports;
			const envPath = api?.environments?.getActiveEnvironmentPath?.();
			if (envPath?.path) {
				return envPath.path;
			}
		} catch {
			// Fall through to the PATH-based default below.
		}
	}
	return process.platform === 'win32' ? 'python' : 'python3';
}

// Wraps the source under test and a single generated property-based test in a
// self-running Python script: the source is defined first, then a hypothesis
// profile (no database, 1000 examples) is loaded, then the test, then a small
// runner invokes every test* function (a hypothesis @given function runs when
// called) and reports failures via a non-zero exit code. The harness names are
// underscore-prefixed so they never collide with a test* function.
function buildTestScript(source: string, test: string): string {
	// The profile is loaded between the source and the test so it is active before
	// the test's @given decorators run (they bind their settings at decoration
	// time). It sits after the source so any `from __future__` import there stays
	// the file's first statement. Source first also keeps line numbers stable. A
	// test's own @settings decorator still overrides the profile.
	return `${source}

from hypothesis import settings as _ibdg_settings
_ibdg_settings.register_profile("ibdg", max_examples=1000, database=None)
_ibdg_settings.load_profile("ibdg")

${test}

if __name__ == "__main__":
    import sys as _sys, traceback as _tb
    _tests = [(_n, _o) for _n, _o in list(globals().items()) if _n.startswith("test") and callable(_o)]
    _failed = 0
    for _n, _o in _tests:
        try:
            _o()
        except Exception:
            _failed += 1
            print("FAILED: " + _n)
            _tb.print_exc()
    if not _tests:
        print("No test function was found to run.")
        _sys.exit(1)
    if _failed == 0:
        print("All property-based tests passed.")
    _sys.exit(1 if _failed else 0)
`;
}

// Writes the combined script to a temp file, runs it with the resolved Python
// interpreter, and resolves with whether it passed (exit code 0) plus the
// captured stdout+stderr. The process is killed after a timeout so a pathological
// test can't hang the panel, and the temp file is always cleaned up.
async function runPythonTest(source: string, test: string): Promise<{ ok: boolean; output: string }> {
	const python = await resolvePythonCommand();
	const script = buildTestScript(source ?? '', test ?? '');
	const file = path.join(os.tmpdir(), `ibdg_pbt_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
	await fs.promises.writeFile(file, script, 'utf8');

	try {
		return await new Promise<{ ok: boolean; output: string }>((resolve) => {
			const child = spawn(python, [file], { windowsHide: true });
			let out = '';
			const append = (chunk: Buffer) => { out += chunk.toString(); };
			child.stdout.on('data', append);
			child.stderr.on('data', append);

			// Guard against a runaway test (e.g. an accidental infinite loop).
			const timer = setTimeout(() => {
				child.kill();
				out += '\nTest run timed out after 60 seconds and was stopped.';
			}, 60000);

			child.on('error', (err) => {
				clearTimeout(timer);
				const hint = `Could not run Python ("${python}"): ${err.message}. ` +
					'Make sure Python and the hypothesis library are installed.';
				resolve({ ok: false, output: hint });
			});
			child.on('close', (codeNum) => {
				clearTimeout(timer);
				const text = out.trim() || (codeNum === 0 ? 'All property-based tests passed.' : 'The test failed with no output.');
				resolve({ ok: codeNum === 0, output: text });
			});
		});
	} finally {
		fs.promises.unlink(file).catch(() => { /* best-effort cleanup */ });
	}
}

class PythonFunctionCodeLens extends vscode.CodeLens {
	constructor(range: vscode.Range, public readonly document: vscode.TextDocument, public readonly functionRange: vscode.Range) {
		super(range);
	}
}

class PythonFunctionCodeLensProvider implements vscode.CodeLensProvider {
	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];
		const defRegex = /^(\s*)(?:async\s+)?def\s+\w+/;

		for (let i = 0; i < document.lineCount; i++) {
			const match = document.lineAt(i).text.match(defRegex);
			if (!match) {
				continue;
			}

			const defIndent = match[1].length;

			// Pull in any decorator lines stacked directly above the def line
			const start = this.findDecoratorStart(document, i, defIndent);

			let end = i;

			// The function body is every following line indented deeper than the def line
			for (let j = i + 1; j < document.lineCount; j++) {
				const line = document.lineAt(j);
				if (line.isEmptyOrWhitespace) {
					continue;
				}
				if (line.firstNonWhitespaceCharacterIndex <= defIndent) {
					break;
				}
				end = j;
			}

			const functionRange = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
			lenses.push(new PythonFunctionCodeLens(new vscode.Range(start, 0, start, 0), document, functionRange));
		}

		return lenses;
	}

	// Walks upward from a def line over any decorators (including multi-line ones)
	// and returns the line where the decorated construct begins.
	private findDecoratorStart(document: vscode.TextDocument, defLine: number, defIndent: number): number {
		let start = defLine;
		let depth = 0; // unmatched closing brackets seen while scanning upward

		for (let j = defLine - 1; j >= 0; j--) {
			const line = document.lineAt(j);

			// At a logical line boundary a blank line or a dedent ends the block
			if (depth === 0) {
				if (line.isEmptyOrWhitespace || line.firstNonWhitespaceCharacterIndex < defIndent) {
					break;
				}
			}

			depth += this.netClosingBrackets(line.text);

			if (depth < 0) {
				depth = 0; // tolerate unbalanced lines (e.g. brackets inside strings)
			}

			if (depth === 0) {
				// This line is the head of a logical statement
				const isDecorator =
					line.firstNonWhitespaceCharacterIndex === defIndent && line.text.trim().startsWith('@');
				if (isDecorator) {
					start = j; // include it and keep looking for more decorators above
				} else {
					break;
				}
			}
			// depth > 0: still inside a multi-line decorator's arguments, keep going up
		}

		return start;
	}

	// Net count of closing brackets minus opening brackets on a line.
	// Used to detect when we are inside a multi-line decorator's argument list.
	// known issue: Does not detect strings
	private netClosingBrackets(text: string): number {
		let net = 0;
		for (const ch of text) {
			if (ch === ')' || ch === ']' || ch === '}') {
				net++;
			} else if (ch === '(' || ch === '[' || ch === '{') {
				net--;
			}
		}
		return net;
	}

	resolveCodeLens(codeLens: vscode.CodeLens): vscode.CodeLens | null {
		if (!(codeLens instanceof PythonFunctionCodeLens)) {
			return null;
		}

		codeLens.command = {
			title: 'Generate Invariant-Based Documentation',
			command: 'invariant-based-documentation-generator.generator',
			arguments: [codeLens.document.getText(codeLens.functionRange)]
		};
		return codeLens;
	}
}

function escapeHtml(text: string) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function getWebViewContent(functionCode: string, webview: vscode.Webview, extensionUri: vscode.Uri) {
	// Webview URIs for the bundled libraries and our media assets, plus a nonce.
	// The CSP allows the three nonce'd top-level scripts (marked, DOMPurify, and
	// the main.js module); main.js then imports its sibling modules (state/render/
	// view), which the CSP permits via webview.cspSource.
	const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'marked', 'lib', 'marked.umd.js'));
	const domPurifyUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'dompurify', 'dist', 'purify.min.js'));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
	const nonce = getNonce();
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Invariant-Based Documentation Generator</title>
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <h1>Invariant-Based Documentation Generator</h1>
    <div id="flow">
        <button type="button" data-action="source" disabled>01 Source code</button>
        <span class="flow-arrow">&rarr;</span>
        <button type="button" data-action="invariants">02 Invariants</button>
        <span class="flow-arrow">&rarr;</span>
        <button type="button" data-action="pbt" disabled>03 PBT</button>
        <span class="flow-arrow">&rarr;</span>
        <button type="button" data-action="documentation" disabled>04 Documentation</button>
    </div>
    <textarea id="code" spellcheck="false" wrap="off" placeholder="Source code goes here...">${escapeHtml(functionCode)}</textarea>
    <div id="actions">
        <button type="button" class="action" id="generate-invariants">Generate Invariants</button>
        <button type="button" class="action" id="generate-invariants-pbt" hidden>Generate Invariants and PBT</button>
        <button type="button" class="action" id="generate-pbt" hidden>Generate Property-based test cases</button>
		<button type="button" class="action" id="run-all-tests" hidden>Run all tests</button>
        <button type="button" class="action" id="generate-documentation" hidden>Regenerate documentation</button>
    </div>
    <h2 id="result-title">Invariants</h2>
    <div id="result"></div>
    <button type="button" class="action" id="approve-documentation" hidden>Looks good, generate Documentation</button>
    <script nonce="${nonce}" src="${markedUri}"></script>
    <script nonce="${nonce}" src="${domPurifyUri}"></script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// This method is called when your extension is deactivated
export function deactivate() {}
