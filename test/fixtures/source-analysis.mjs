import { parse } from "@babel/parser";

export function syntax(source, filename = "source.ts") {
  return parse(source, { sourceType: "unambiguous", plugins: filename.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] });
}

/** @param {(node: any, parents: any[]) => void} visit */
export function walk(node, visit, parents = []) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") {
    visit(node, parents);
    parents = [...parents, node];
  }
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "tokens", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, parents));
    else if (value && typeof value === "object") walk(value, visit, parents);
  }
}

/** Include runtime re-exports, literal dynamic imports and require; reject opaque module loading. */
export function runtimeImports(source, filename = "source.ts") {
  /** @type {Set<string>} */
  const imports = new Set();
  walk(syntax(source, filename), node => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
      if (node.importKind === "type" || node.exportKind === "type") return;
      if (node.specifiers?.length && node.specifiers.every(s => s.importKind === "type" || s.exportKind === "type")) return;
      imports.add(node.source.value);
    }
    const dynamic = node.type === "ImportExpression" ? node.source
      : node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require" ? node.arguments[0]
        : node.type === "TSImportEqualsDeclaration" && node.moduleReference.type === "TSExternalModuleReference" && node.importKind !== "type" ? node.moduleReference.expression : undefined;
    if (dynamic) {
      if (dynamic.type !== "StringLiteral") throw new Error("Cannot verify a non-literal runtime import");
      imports.add(dynamic.value);
    }
  });
  return [...imports];
}

export function memberName(node) {
  if (!["MemberExpression", "OptionalMemberExpression"].includes(node?.type)) return undefined;
  return node.computed ? node.property.type === "StringLiteral" ? node.property.value : undefined : node.property.name;
}

/** The grant factory must be used immediately for an explicit dry swap, never retained or aliased. */
export function assertDryGrantUses(source) {
  const tree = syntax(source);
  const factories = new Set();
  const agentModule = value => typeof value === "string" && /(?:^|\/)agent(?:\.js)?$/.test(value);
  for (const node of tree.program.body) {
    if (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && agentModule(node.source?.value) && node.exportKind !== "type") {
      if (node.type === "ExportAllDeclaration" || node.specifiers.some(specifier => specifier.local?.name === "agent" && specifier.exportKind !== "type")) throw new Error("Grant factory cannot be re-exported");
    }
    if (node.type === "ImportDeclaration" && agentModule(node.source.value) && node.importKind !== "type") {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") throw new Error("Namespace imports hide grant-factory use");
        if (specifier.imported?.name === "agent" && specifier.importKind !== "type" && node.importKind !== "type") factories.add(specifier.local.name);
      }
    }
  }
  let uses = 0;
  walk(tree, (node, parents) => {
    if (node.type === "ImportExpression" && agentModule(node.source.value) || node.type === "CallExpression" && node.callee.name === "require" && agentModule(node.arguments[0]?.value)) throw new Error("Grant factory module must use explicit static imports");
    const parent = parents.at(-1);
    if (node.type !== "Identifier" || !factories.has(node.name) || parent?.type === "ImportSpecifier") return;
    const member = parents.at(-2), call = parents.at(-3);
    if (parent?.type !== "CallExpression" || parent.callee !== node || parent.arguments.length || member?.object !== parent || memberName(member) !== "swap" || call?.type !== "CallExpression" || call.callee !== member) throw new Error("Grant factory must be used only for a direct dry quote");
    const request = call.arguments[1];
    const last = request?.type === "ObjectExpression" ? request.properties.at(-1) : undefined;
    if (last?.type !== "ObjectProperty" || last.computed || (last.key.name ?? last.key.value) !== "dry" || last.value.type !== "BooleanLiteral" || last.value.value !== true) throw new Error("Quote must end with an explicit dry: true");
    uses++;
  });
  return uses;
}
