// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated as soon as a Python file is opened (see activationEvents in package.json)
export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(
		vscode.commands.registerCommand('invariant-based-documentation-generator.generator', (functionCode: string = '') => {
			const panel = vscode.window.createWebviewPanel('IBDGenerator', 'Invariant-Based Documentation Generator', vscode.ViewColumn.Beside, {});
			panel.webview.html = getWebViewContent(functionCode);
			panel.onDidDispose(() => {}, null, context.subscriptions);
		})
	);

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ language: 'python' }, new PythonFunctionCodeLensProvider())
	);
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
</head>
<body>
    <h1>Invariant-Based Documentation Generator</h1>
    <pre>${escapeHtml(functionCode)}</pre>
</body>
</html>`;
}

// This method is called when your extension is deactivated
export function deactivate() {}
