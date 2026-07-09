import { describe, it } from 'vitest';
import { swiftuiTranslator } from '../swiftuiTranslator';

describe('debug', () => {
  it('print AST', () => {
    const ast = swiftuiTranslator.translate('Text("hello").padding(16).background(Color.red)');
    console.log('AST:', JSON.stringify(ast, null, 2));
  });
});
