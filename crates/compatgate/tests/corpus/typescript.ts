// TypeScript: types and ambient declarations produce no JavaScript.

// ignores_typescript_type_references
let s: Intl.Segmenter | undefined; //~ none
let o: ResizeObserver; //~ none

// ignores_values_in_typescript_ambient_declarations
declare namespace N { const a = structuredClone; } //~ none
declare function f(a = structuredClone(1)): void; //~ none

// a_member_called_through_a_wrapper_is_a_call
try { (window.structuredClone as any)(1); } catch (e) {} //~ none
