// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config({ ignores: ['dist/', 'node_modules/', 'public/'] }, ...tseslint.configs.recommended, {
  rules: {
    // tsc already flags unused locals and parameters (noUnusedLocals/noUnusedParameters); `_x` is the opt-out there
    '@typescript-eslint/no-unused-vars': 'off',
    // `let keeper!: X` filled in after the closures that read it are made: the forward reference needs a `let`
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    // the engine works over untyped field records on purpose, so `any` in a cast is a considered choice, not an accident
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
});
