import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {
	test('contributes its commands and settings', async () => {
		const ext = vscode.extensions.getExtension('nuhmanpk.nanometrics');
		assert.ok(ext, 'extension not found');
		await ext.activate();

		const commands = await vscode.commands.getCommands(true);
		for (const id of ['nanometrics.showSystem', 'nanometrics.showProject', 'nanometrics.togglePause']) {
			assert.ok(commands.includes(id), `${id} not registered`);
		}

		const config = vscode.workspace.getConfiguration('nanometrics');
		assert.strictEqual(config.get('statusBarStyle'), 'full');
		assert.deepStrictEqual(config.get('claudePricing'), {});
	});
});
