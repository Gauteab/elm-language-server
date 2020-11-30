import { container } from "tsyringe";
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Connection,
  Diagnostic,
  TextEdit,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { SyntaxNode, Tree } from "web-tree-sitter";
import { IElmWorkspace } from "../elmWorkspace";
import { ElmWorkspaceMatcher, IParams } from "../util/elmWorkspaceMatcher";
import { MultiMap } from "../util/multiMap";
import { RefactorEditUtils } from "../util/refactorEditUtils";
import { Settings } from "../util/settings";
import { flatMap, TreeUtils } from "../util/treeUtils";
import { Diagnostics } from "../util/types/diagnostics";
import { ElmLsDiagnostics } from "./diagnostics/elmLsDiagnostics";
import { ElmMakeDiagnostics } from "./diagnostics/elmMakeDiagnostics";
import { diagnosticsEquals } from "./diagnostics/fileDiagnostics";
import { ExposeUnexposeHandler } from "./handlers/exposeUnexposeHandler";
import { MoveRefactoringHandler } from "./handlers/moveRefactoringHandler";

export type ICodeActionParams = CodeActionParams & IParams;

export interface ICodeActionRegistration {
  errorCodes: string[];
  getCodeActions(params: ICodeActionParams): CodeAction[] | undefined;
  getFixAllCodeAction(params: ICodeActionParams): CodeAction | undefined;
}

export class CodeActionProvider {
  private connection: Connection;
  private settings: Settings;
  private elmMake: ElmMakeDiagnostics;
  private elmDiagnostics: ElmLsDiagnostics;

  private static errorCodeToRegistrationMap = new MultiMap<
    string,
    ICodeActionRegistration
  >();

  constructor() {
    this.settings = container.resolve("Settings");
    this.elmMake = container.resolve(ElmMakeDiagnostics);
    this.elmDiagnostics = container.resolve(ElmLsDiagnostics);
    this.connection = container.resolve<Connection>("Connection");

    this.onCodeAction = this.onCodeAction.bind(this);
    this.connection.onCodeAction(
      new ElmWorkspaceMatcher((param: CodeActionParams) =>
        URI.parse(param.textDocument.uri),
      ).handle(this.onCodeAction.bind(this)),
    );

    if (this.settings.extendedCapabilities?.moveFunctionRefactoringSupport) {
      new MoveRefactoringHandler();
    }

    new ExposeUnexposeHandler();
  }

  public static registerCodeAction(
    registration: ICodeActionRegistration,
  ): void {
    registration.errorCodes.forEach((code) => {
      CodeActionProvider.errorCodeToRegistrationMap.set(code, registration);
    });
  }

  private static forEachDiagnostic(
    params: ICodeActionParams,
    errorCodes: string[],
    callback: (diagnostic: Diagnostic) => void,
  ): void {
    params.program.getDiagnostics(params.sourceFile).forEach((diagnostic) => {
      if (
        typeof diagnostic.code === "string" &&
        errorCodes.includes(diagnostic.code)
      ) {
        callback(diagnostic);
      }
    });
  }

  public static getCodeAction(
    params: ICodeActionParams,
    title: string,
    edits: TextEdit[],
  ): CodeAction {
    const changes = { [params.sourceFile.uri]: edits };
    return {
      title,
      kind: CodeActionKind.QuickFix,
      edit: { changes },
      isPreferred: true,
    };
  }

  public static getFixAllCodeAction(
    title: string,
    params: ICodeActionParams,
    errorCodes: string[],
    callback: (edits: TextEdit[], diagnostic: Diagnostic) => void,
  ): CodeAction {
    const edits: TextEdit[] = [];
    const changes = {
      [params.sourceFile.uri]: edits,
    };

    const diagnostics: Diagnostic[] = [];
    CodeActionProvider.forEachDiagnostic(params, errorCodes, (diagnostic) => {
      diagnostics.push(diagnostic);
      callback(edits, diagnostic);
    });

    return {
      title,
      kind: CodeActionKind.SourceFixAll,
      diagnostics,
      edit: { changes },
    };
  }

  protected onCodeAction(params: ICodeActionParams): CodeAction[] | undefined {
    this.connection.console.info("A code action was requested");
    const make = this.elmMake.onCodeAction(params);
    const elmDiagnostics = this.elmDiagnostics.onCodeAction(params);

    const results: CodeAction[] = [];

    // For each diagnostic in the context, get the code action registration that
    // handles the diagnostic error code and ask for the code actions for that error
    // and the fix all code action for that error if there are other diagnostics with
    // the same error code
    params.context.diagnostics.forEach((diagnostic) => {
      if (typeof diagnostic?.code === "string") {
        const registrations = CodeActionProvider.errorCodeToRegistrationMap.getAll(
          diagnostic.code,
        );

        // Set the params range to the diagnostic range so we get the correct nodes
        params.range = diagnostic.range;

        results.push(
          ...flatMap(registrations, (reg) => {
            const codeActions =
              reg
                .getCodeActions(params)
                ?.map((codeAction) =>
                  this.addDiagnosticToCodeAction(codeAction, diagnostic),
                ) ?? [];

            if (
              codeActions.length > 0 &&
              params.program
                .getDiagnostics(params.sourceFile)
                .some(
                  (diag) =>
                    !diagnosticsEquals(diag, diagnostic) &&
                    diag.code === diagnostic.code,
                )
            ) {
              const fixAllCodeAction = reg.getFixAllCodeAction(params);

              if (fixAllCodeAction) {
                codeActions?.push(fixAllCodeAction);
              }
            }

            return codeActions;
          }),
        );
      }
    });

    return [
      ...results,
      ...this.convertDiagnosticsToCodeActions(
        params.context.diagnostics,
        params.program,
        params.textDocument.uri,
      ),
      ...this.getRefactorCodeActions(params),
      ...this.getTypeAnnotationCodeActions(params),
      ...make,
      ...elmDiagnostics,
    ];
  }

  private getTypeAnnotationCodeActions(
    params: ICodeActionParams,
  ): CodeAction[] {
    // Top level annotation are handled by diagnostics
    const codeActions: CodeAction[] = [];

    const forest = params.program.getForest();
    const treeContainer = forest.getByUri(params.textDocument.uri);
    const tree = treeContainer?.tree;
    const checker = params.program.getTypeChecker();

    if (tree) {
      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        tree.rootNode,
        params.range.start,
      );

      if (
        nodeAtPosition.parent?.type === "function_declaration_left" &&
        TreeUtils.findParentOfType("let_in_expr", nodeAtPosition) &&
        nodeAtPosition.parent.parent &&
        !TreeUtils.getTypeAnnotation(nodeAtPosition.parent.parent)
      ) {
        const typeString: string = checker.typeToString(
          checker.findType(nodeAtPosition.parent),
          treeContainer,
        );

        codeActions.push({
          edit: {
            changes: {
              [params.textDocument.uri]: [
                TextEdit.insert(
                  {
                    line: nodeAtPosition.startPosition.row,
                    character: nodeAtPosition.startPosition.column,
                  },
                  `${nodeAtPosition.text} : ${typeString}\n${Array(
                    nodeAtPosition.startPosition.column + 1,
                  ).join(" ")}`,
                ),
              ],
            },
          },
          kind: CodeActionKind.QuickFix,
          title: "Add inferred annotation",
        });
      }
    }

    return codeActions;
  }

  private getRefactorCodeActions(params: ICodeActionParams): CodeAction[] {
    const codeActions: CodeAction[] = [];

    const forest = params.program.getForest();
    const tree = forest.getTree(params.textDocument.uri);

    if (tree) {
      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        tree.rootNode,
        params.range.start,
      );

      codeActions.push(
        ...this.getFunctionCodeActions(params, tree, nodeAtPosition),
        ...this.getTypeAliasCodeActions(params, tree, nodeAtPosition),
        ...this.getMakeDeclarationFromUsageCodeActions(params, nodeAtPosition),
      );
    }

    return codeActions;
  }

  private getFunctionCodeActions(
    params: CodeActionParams,
    tree: Tree,
    nodeAtPosition: SyntaxNode,
  ): CodeAction[] {
    const codeActions: CodeAction[] = [];

    if (
      (nodeAtPosition.parent?.type === "type_annotation" ||
        nodeAtPosition.parent?.type === "function_declaration_left") &&
      !TreeUtils.findParentOfType("let_in_expr", nodeAtPosition)
    ) {
      const functionName = nodeAtPosition.text;

      if (this.settings.extendedCapabilities?.moveFunctionRefactoringSupport) {
        codeActions.push({
          title: "Move Function",
          command: {
            title: "Refactor",
            command: "elm.refactor",
            arguments: [
              "moveFunction",
              { textDocument: params.textDocument, range: params.range },
              functionName,
            ],
          },
          kind: CodeActionKind.RefactorRewrite,
        });
      }

      if (TreeUtils.isExposedFunction(tree, functionName)) {
        const edit = RefactorEditUtils.unexposedValueInModule(
          tree,
          functionName,
        );

        if (edit) {
          codeActions.push({
            title: "Unexpose Function",
            edit: {
              changes: {
                [params.textDocument.uri]: [edit],
              },
            },
            kind: CodeActionKind.Refactor,
          });
        }
      } else {
        const edit = RefactorEditUtils.exposeValueInModule(tree, functionName);

        if (edit) {
          codeActions.push({
            title: "Expose Function",
            edit: {
              changes: {
                [params.textDocument.uri]: [edit],
              },
            },
            kind: CodeActionKind.Refactor,
          });
        }
      }
    }

    return codeActions;
  }

  private getTypeAliasCodeActions(
    params: CodeActionParams,
    tree: Tree,
    nodeAtPosition: SyntaxNode,
  ): CodeAction[] {
    const codeActions: CodeAction[] = [];

    if (
      nodeAtPosition.type === "upper_case_identifier" &&
      (nodeAtPosition.parent?.type === "type_alias_declaration" ||
        nodeAtPosition.parent?.type === "type_declaration")
    ) {
      const typeName = nodeAtPosition.text;

      const alias =
        nodeAtPosition.parent?.type === "type_alias_declaration"
          ? " Alias"
          : "";

      if (TreeUtils.isExposedTypeOrTypeAlias(tree, typeName)) {
        const edit = RefactorEditUtils.unexposedValueInModule(tree, typeName);

        if (edit) {
          codeActions.push({
            title: `Unexpose Type${alias}`,
            edit: {
              changes: {
                [params.textDocument.uri]: [edit],
              },
            },
            kind: CodeActionKind.Refactor,
          });
        }
      } else {
        const edit = RefactorEditUtils.exposeValueInModule(tree, typeName);

        if (edit) {
          codeActions.push({
            title: `Expose Type${alias}`,
            edit: {
              changes: {
                [params.textDocument.uri]: [edit],
              },
            },
            kind: CodeActionKind.Refactor,
          });
        }
      }
    }

    return codeActions;
  }

  private getMakeDeclarationFromUsageCodeActions(
    params: ICodeActionParams,
    nodeAtPosition: SyntaxNode,
  ): CodeAction[] {
    const codeActions: CodeAction[] = [];

    if (
      nodeAtPosition.type === "lower_case_identifier" &&
      nodeAtPosition.parent?.parent?.type === "value_expr" &&
      nodeAtPosition.parent?.parent?.parent &&
      nodeAtPosition.previousSibling?.type !== "dot"
    ) {
      const funcName = nodeAtPosition.text;

      const tree = params.sourceFile.tree;
      const checker = params.program.getTypeChecker();

      if (
        !TreeUtils.findAllTopLevelFunctionDeclarations(tree)?.some(
          (a) =>
            a.firstChild?.text == funcName ||
            a.firstChild?.firstChild?.text == funcName,
        )
      ) {
        const insertLineNumber = RefactorEditUtils.findLineNumberAfterCurrentFunction(
          nodeAtPosition,
        );

        const typeString: string = checker.typeToString(
          checker.findType(nodeAtPosition),
          params.sourceFile,
        );

        const edit = RefactorEditUtils.createTopLevelFunction(
          insertLineNumber ?? tree.rootNode.endPosition.row,
          funcName,
          typeString,
          TreeUtils.findParentOfType("function_call_expr", nodeAtPosition),
        );

        if (edit) {
          codeActions.push({
            title: `Create local function`,
            edit: {
              changes: {
                [params.textDocument.uri]: [edit],
              },
            },
            kind: CodeActionKind.QuickFix,
          });
        }
      }
    }

    return codeActions;
  }

  private convertDiagnosticsToCodeActions(
    diagnostics: Diagnostic[],
    elmWorkspace: IElmWorkspace,
    uri: string,
  ): CodeAction[] {
    const result: CodeAction[] = [];

    const forest = elmWorkspace.getForest();
    const treeContainer = forest.getByUri(uri);
    const checker = elmWorkspace.getTypeChecker();

    if (treeContainer) {
      diagnostics.forEach((diagnostic) => {
        switch (diagnostic.code) {
          case Diagnostics.MissingTypeAnnotation.code:
            {
              const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
                treeContainer.tree.rootNode,
                diagnostic.range.start,
              );

              if (nodeAtPosition.parent) {
                const typeString: string = checker.typeToString(
                  checker.findType(nodeAtPosition.parent),
                  treeContainer,
                );

                result.push(
                  this.insertQuickFixAtStart(
                    uri,
                    `${nodeAtPosition.text} : ${typeString}\n`,
                    diagnostic,
                    "Add inferred annotation",
                  ),
                );
              }
            }
            break;
        }
      });
    }

    return result;
  }

  private insertQuickFixAtStart(
    uri: string,
    replaceWith: string,
    diagnostic: Diagnostic,
    title: string,
  ): CodeAction {
    const map: {
      [uri: string]: TextEdit[];
    } = {};
    if (!map[uri]) {
      map[uri] = [];
    }
    map[uri].push(TextEdit.insert(diagnostic.range.start, replaceWith));
    return {
      diagnostics: [diagnostic],
      edit: { changes: map },
      kind: CodeActionKind.QuickFix,
      title,
    };
  }

  private addDiagnosticToCodeAction(
    codeAction: CodeAction,
    diagnostic: Diagnostic,
  ): CodeAction {
    codeAction.diagnostics = [diagnostic];
    return codeAction;
  }
}
