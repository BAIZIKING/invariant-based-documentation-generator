// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ClaudeConfig, query_claude } from './backend';

// Key under which the Anthropic API key is stored in VS Code's SecretStorage.
// SecretStorage keeps the key encrypted and out of settings.json (which is plain
// text and may sync across machines).
const API_KEY_SECRET = 'invariant-based-documentation-generator.apiKey';

// This method is called when your extension is activated
// Your extension is activated as soon as a Python file is opened (see activationEvents in package.json)
export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(
		vscode.commands.registerCommand('invariant-based-documentation-generator.generator', (functionCode: string = '') => {
			const panel = vscode.window.createWebviewPanel('IBDGenerator', 'Invariant-Based Documentation Generator', vscode.ViewColumn.Beside, { enableScripts: true });
			panel.webview.html = getWebViewContent(functionCode);

			panel.webview.onDidReceiveMessage(async (message) => {
				if (message?.type !== 'generateInvariants') {
					return;
				}
				const config = await resolveClaudeConfig(context);
				if (!config) {
					panel.webview.postMessage({ type: 'invariantsError', text: 'No Anthropic API key is set.' });
					return;
				}
				try {
					const text = await query_claude(message.code, config);
					panel.webview.postMessage({ type: 'invariantsResult', text });
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					panel.webview.postMessage({ type: 'invariantsError', text: `Error: ${detail}` });
				}
			}, undefined, context.subscriptions);

			panel.onDidDispose(() => {}, null, context.subscriptions);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('invariant-based-documentation-generator.setApiKey', async () => {
			const apiKey = await vscode.window.showInputBox({
				title: 'Anthropic API Key',
				prompt: 'Enter your Anthropic API key (sk-ant-...). It is stored securely in VS Code SecretStorage.',
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

function getWebViewContent(functionCode: string) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Invariant-Based Documentation Generator</title>
    <style>
        html, body {
            height: 100%;
        }
        body {
            display: flex;
            flex-direction: column;
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
        }
        #code {
            flex: 0 0 auto;
            height: 30%;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            color: var(--vscode-input-foreground);
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 8px;
            white-space: pre;
			resize: vertical;
            overflow: auto;
			min-height: 1em;
			margin-bottom: 8px;
        }
        #actions {
            display: flex;
            flex-direction: row;
            flex-wrap: wrap;
            gap: 4px;
        }
        #actions button {
            color: var(--vscode-button-foreground);
            background-color: var(--vscode-button-background);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
        }
        #actions button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        #result {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            border: 1px solid var(--vscode-panel-border);
        }
    </style>
</head>
<body>
    <h1>Invariant-Based Documentation Generator</h1>
    <textarea id="code" spellcheck="false" wrap="off" placeholder="Source code goes here...">${escapeHtml(functionCode)}</textarea>
    <div id="actions">
        <button type="button" id="generate-invariants">Generate Invariants</button>
        <button type="button">Generate Property-based test cases</button>
        <button type="button">Generate documentation</button>
    </div>
    <h2 id="result-title">Invariants</h2>
    <div id="result"></div>
    <script>
        const vscode = acquireVsCodeApi();
        const resultTitle = document.getElementById('result-title');
        const result = document.getElementById('result');
        const code = document.getElementById('code');

        for (const btn of document.querySelectorAll('#actions button')) {
            btn.addEventListener('click', () => {
                const label = btn.textContent.replace(/^Generate\\s+/, '');
                resultTitle.textContent = label.charAt(0).toUpperCase() + label.slice(1);
            });
        }

        document.getElementById('generate-invariants').addEventListener('click', () => {
            result.textContent = 'Generating...';
            vscode.postMessage({ type: 'generateInvariants', code: code.value });
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.type === 'invariantsResult' || message.type === 'invariantsError') {
                result.textContent = message.text;
            }
        });
    </script>
</body>
</html>`;
}

// This method is called when your extension is deactivated
export function deactivate() {}
