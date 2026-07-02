import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as path from 'path';
import { domainToASCII, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';
import { LLMConfig, Conversation, backend, invariant_prompt } from '../backend/main';

// Real generation goes through Claude, which is slow and costs money on every
// run. These stubs mirror the real backend.query_* functions but return canned
// data, so the extension can be exercised end-to-end without any LLM calls.
// They are installed over the backend registry in suiteSetup below, which makes
// the extension run these instead of the real functions for the whole suite.

// Mirrors backend.query_invariants: returns the validated, structured object
// (matching InvariantsSchema) plus the conversation.
async function query_invariants_good(code: string, config: LLMConfig) {
	// await new Promise(resolve => setTimeout(resolve, 3000));
	const text = {
		output: [
			{ invariant: "The output array has the same shape as the input array.", lineno: 10, end_lineno: 14 },
			{ invariant: "All elements of the returned array are non-negative.", lineno: 16, end_lineno: 18 },
			{ invariant: "Raises ValueError when the input array is empty.", lineno: 5, end_lineno: 7 },
		],
	};
	const conversation: Conversation = {
		messages: [
			{ role: "user", content: invariant_prompt(code) },
			{ role: "assistant", content: JSON.stringify(text) },
		],
	};
	return { text, conversation };
}

// Mirrors backend.query_test_cases: returns the validated, structured object
// (matching PbtSchema).
async function query_test_cases_good(
	invariants: string[],
	prev: Conversation,
	config: LLMConfig
) {
	// throw new Error;
	return {
		output: [
			{
				invariant: "The output array has the same shape as the input array.",
				explanation: "Generate arbitrarily shaped arrays and assert the result shape equals the input shape.",
				test: "from hypothesis import given\nimport hypothesis.extra.numpy as npst\n\n@given(npst.arrays(dtype=float, shape=npst.array_shapes()))\ndef test_same_shape(a):\n    assert f(a).shape == a.shape",
			},
			{
				invariant: "All elements of the returned array are non-negative.",
				explanation: "For any input array, every element of the result must be >= 0.",
				test: "from hypothesis import given\nimport hypothesis.extra.numpy as npst\n\n@given(npst.arrays(dtype=float, shape=npst.array_shapes()))\ndef test_non_negative(a):\n    assert (f(a) >= 0).all()",
			},
		],
	};
}

// Mirrors backend.query_documentation.
async function query_documentation_good(code: string, invariants: string[], config: LLMConfig) {
	return `# normalize

## Overview

Scales an array so its elements are non-negative and preserve the input shape.

## Parameters

- \`a\`: the input array.

## Semantic Guarantees

- The output array has the same shape as the input array.
- All elements of the returned array are non-negative.

## Raises

- \`ValueError\` when the input array is empty.

## Examples

\`\`\`python
normalize(np.array([-1.0, 2.0]))
\`\`\``;
}

suite('Normal execution e2e test', () => {
	vscode.window.showInformationMessage('Start nromal execution tests.');

	// Swap the real backend functions for the stubs above so the whole suite
	// runs offline, with no real LLM calls.
	suiteSetup(async () => {
		backend.query_invariants = query_invariants_good;
		backend.query_test_cases = query_test_cases_good;
		backend.query_documentation = query_documentation_good;

		// The webview front end (media/*.js) is browser code, so stand up a
		// browser-like environment in this Node test process. This is a copy of
		// the page markup produced by getWebViewContent, minus the CSP meta tag
		// and the <link>/<script> tags: those load webview-only resources by URI,
		// which don't resolve here. Instead we supply the same libraries as
		// globals below and import the entry module ourselves.
		const page = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Invariant-Based Documentation Generator</title>
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
    <pre id="code-view"></pre>
    <textarea id="code" spellcheck="false" wrap="off" hidden disabled></textarea>
    <div id="actions">
        <button type="button" class="action" id="generate-invariants">Generate Invariants</button>
        <button type="button" class="action" id="generate-invariants-pbt" hidden>Generate Invariants and PBT</button>
        <button type="button" class="action" id="generate-pbt" hidden>Generate Property-based test cases</button>
        <button type="button" class="action" id="run-all-tests" hidden>Run all tests</button>
        <button type="button" class="action" id="generate-documentation" hidden>Regenerate documentation</button>
        <button type="button" id="view-raw" hidden>View Raw Markdown</button>
    </div>
    <h2 id="result-title">Invariants</h2>
    <div id="result"></div>
    <button type="button" class="action" id="approve-documentation" hidden>Looks good, generate Documentation</button>
    <button type="button" class="action" id="download-documentation" hidden>Download documentation</button>
</body>
</html>`;

		const dom = new JSDOM(page, { url: 'https://localhost/' });
		const g = globalThis as any;
		g.window = dom.window;
		g.document = dom.window.document;
		// The webview API handle the front end acquires once at load. It only ever
		// calls postMessage (persistence uses retainContextWhenHidden, not
		// getState/setState), so a postMessage stub is enough.
		g.acquireVsCodeApi = () => ({
			postMessage: (message: any) => message,
		});
		
		g.marked = { parse: (md: string) => md };
		g.DOMPurify = { sanitize: (html: string) => html };

		// Import the front-end entry point. It runs its module side effects against
		// the DOM above: wiring event listeners and doing the initial render.
		require("../../media/main.js");
	});

	suiteTeardown(() => {
    	vscode.window.showInformationMessage('All tests done!');
 	});

	test('flow', () => {
		// initial state: no content
		const source_button = window.document.querySelector('#flow button[data-action=source]') as HTMLButtonElement;
		assert.ok(source_button);
		assert.ok(source_button.classList.contains('completed'));
		assert.strictEqual(1, source_button.classList);
		assert.ok(source_button.disabled);
		const invariants_button = window.document.querySelector('#flow button[data-action=invariants]') as HTMLButtonElement;
		assert.ok(invariants_button);
		assert.ok(invariants_button.classList.contains('current'));
		assert.strictEqual(1, invariants_button.classList);
		assert.ok(!invariants_button.disabled);
		const pbt_button = window.document.querySelector('#flow button[data-action=pbt]') as HTMLButtonElement;
		assert.ok(pbt_button);
		assert.ok(pbt_button.classList.contains('unreachable'));
		assert.strictEqual(1, pbt_button.classList);
		assert.ok(pbt_button.disabled);
		const documentation_button = window.document.querySelector('#flow button[data-action=documentation]') as HTMLButtonElement;
		assert.ok(documentation_button);
		assert.ok(documentation_button.classList.contains('unreachable'));
		assert.strictEqual(1, documentation_button.classList);
		assert.ok(documentation_button.disabled);

		

	});


	
});
