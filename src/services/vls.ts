import * as path from 'path';

import {
  DidChangeConfigurationParams,
  DocumentColorParams,
  DocumentFormattingParams,
  DocumentLinkParams,
  FileChangeType,
  IConnection,
  TextDocumentPositionParams,
  ColorPresentationParams,
  InitializeParams,
  ServerCapabilities,
  TextDocumentSyncKind,
  CancellationToken,
  Disposable,
  Range,
  Position,
  DocumentFormattingRequest,
  ResponseError
} from 'vscode-languageserver';
import {
  ColorInformation,
  CompletionItem,
  Definition,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbolParams,
  Location,
  SignatureHelp,
  SymbolInformation,
  TextDocument,
  TextDocumentChangeEvent,
  TextEdit
} from 'vscode-languageserver-types';
import Uri from 'vscode-uri';
import { runSafeAsync } from '../utils/runner';
import { LanguageModes } from '../modes/languageModes';
import { NULL_COMPLETION, NULL_HOVER, NULL_SIGNATURE } from '../modes/nullMode';
import { DocumentContext } from '../types';
import { DocumentService } from './documentService';
import { VueInfoService } from './vueInfoService';
import { DependencyService } from './dependencyService';
import { builtInConfigs } from '../builtInConfigs';
import get from 'lodash/get';
import defaultsDeep from 'lodash/defaultsDeep';

export class VLS {
  // @Todo: Remove this and DocumentContext
  private workspacePath: string | undefined;
  private clientDynamicRegisterSupport: boolean = false;
  private formatterRegistration: Thenable<Disposable> | null = null;
  private documentService: DocumentService;
  private vueInfoService: VueInfoService;
  private dependencyService: DependencyService;

  private languageModes: LanguageModes;

  private pendingValidationRequests: { [uri: string]: NodeJS.Timer } = {};
  private validationDelayMs = 500;
  private validation: { [k: string]: boolean } = {
    'vue-html': true,
    html: true,
    css: true,
    scss: true,
    less: true,
    postcss: true,
    javascript: true
  };

  constructor(private lspConnection: IConnection) {
    this.documentService = new DocumentService(this.lspConnection);
    this.vueInfoService = new VueInfoService();
    this.dependencyService = new DependencyService();

    this.languageModes = new LanguageModes();
  }

  async init(params: InitializeParams) {
    const workspacePath = params.rootPath;
    if (!workspacePath) {
      this.displayErrorMessage('No workspace path found. Vetur initialization failed.');
      return {
        capabilities: {}
      };
    }
    if (!params.initializationOptions || !params.initializationOptions.config) {
      return this.displayErrorMessage('Missing initializationOptions.config');
    }
    this.clientDynamicRegisterSupport = this.getClientCapability(params, 'workspace.symbol.dynamicRegistration', false);

    this.workspacePath = workspacePath;

    await this.vueInfoService.init(this.languageModes);
    await this.dependencyService.init(
      workspacePath,
      get(params.initializationOptions.config, ['vetur', 'useWorkspaceDependencies'], false)
    );
    await this.languageModes.init(workspacePath, {
      infoService: this.vueInfoService,
      dependencyService: this.dependencyService
    });
    params.initializationOptions.config = defaultsDeep(params.initializationOptions.config, builtInConfigs);
    this.setupConfigListeners();
    this.setupLSPHandlers();
    this.setupFileChangeListeners();

    this.lspConnection.onShutdown(() => {
      this.dispose();
    });
    this.configure(params.initializationOptions.config);
  }

  listen() {
    this.lspConnection.listen();
  }
  private getClientCapability<T>(params: InitializeParams, name: string, def: T) {
    const keys = name.split('.');
    let c: any = params.capabilities;
    for (let i = 0; c && i < keys.length; i++) {
      if (!c.hasOwnProperty(keys[i])) {
        return def;
      }
      c = c[keys[i]];
    }
    return c;
  }
  private setupConfigListeners() {
    this.lspConnection.onDidChangeConfiguration(({ settings }: DidChangeConfigurationParams) => {
      this.configure(settings);
      if (this.clientDynamicRegisterSupport) {
        const enableFormatter = settings && settings.vue && settings.vue.format && settings.vue.format.enable;
        if (enableFormatter) {
          if (!this.formatterRegistration) {
            this.formatterRegistration = this.lspConnection.client.register(DocumentFormattingRequest.type, { documentSelector: [{ language: 'vue' }] });
          }
        } else if (this.formatterRegistration) {
          this.formatterRegistration.then(r => r.dispose());
          this.formatterRegistration = null;
        }
      }
    });

    this.documentService.getAllDocuments().forEach(this.triggerValidation);
  }

  private setupLSPHandlers() {
    this.lspConnection.onCompletion(this.onCompletion.bind(this));
    this.lspConnection.onCompletionResolve(this.onCompletionResolve.bind(this));

    this.lspConnection.onDefinition(this.onDefinition.bind(this));
    this.lspConnection.onDocumentFormatting(this.onDocumentFormatting.bind(this));
    this.lspConnection.onDocumentHighlight(this.onDocumentHighlight.bind(this));
    this.lspConnection.onDocumentLinks(this.onDocumentLinks.bind(this));
    this.lspConnection.onDocumentSymbol(this.onDocumentSymbol.bind(this));
    this.lspConnection.onHover(this.onHover.bind(this));
    this.lspConnection.onReferences(this.onReferences.bind(this));
    this.lspConnection.onSignatureHelp(this.onSignatureHelp.bind(this));

    this.lspConnection.onDocumentColor(this.onDocumentColors.bind(this));
    this.lspConnection.onColorPresentation(this.onColorPresentations.bind(this));
  }

  private setupFileChangeListeners() {
    this.documentService.onDidChangeContent((change: TextDocumentChangeEvent) => {
      this.triggerValidation(change.document);
    });
    this.documentService.onDidClose(e => {
      this.removeDocument(e.document);
      this.cleanPendingValidation(e.document);
      this.lspConnection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
    });
    this.lspConnection.onDidChangeWatchedFiles(({ changes }) => {
      let hasChanges = false;
      const jsMode = this.languageModes.getMode('javascript');
      changes.forEach(c => {
        if (c.type === FileChangeType.Changed) {
          const fsPath = Uri.parse(c.uri).fsPath;
          jsMode.onDocumentChanged!(fsPath);
          hasChanges = true;
        }
      });
      if (hasChanges) {
        this.documentService.getAllDocuments().forEach(d => {
          this.triggerValidation(d);
        });
      }
    });
  }

  configure(config: any): void {
    const veturValidationOptions = config.vetur.validation;
    this.validation['vue-html'] = veturValidationOptions.template;
    this.validation.css = veturValidationOptions.style;
    this.validation.postcss = veturValidationOptions.style;
    this.validation.scss = veturValidationOptions.style;
    this.validation.less = veturValidationOptions.style;
    this.validation.javascript = veturValidationOptions.script;

    this.languageModes.getAllModes().forEach(m => {
      if (m.configure) {
        m.configure(config);
      }
    });
  }

  /**
   * Custom Notifications
   */

  displayInfoMessage(msg: string): void {
    this.lspConnection.sendNotification('$/displayInfo', msg);
  }
  displayWarningMessage(msg: string): void {
    this.lspConnection.sendNotification('$/displayWarning', msg);
  }
  displayErrorMessage(msg: string): void {
    this.lspConnection.sendNotification('$/displayError', msg);
  }

  /**
   * Language Features
   */

  onDocumentFormatting({ textDocument, options }: DocumentFormattingParams, token: CancellationToken): Thenable<TextEdit[] | ResponseError<any>> {
    return runSafeAsync(async () => {
      const doc = this.documentService.getDocument(textDocument.uri)!;
      const fullDocRange = Range.create(Position.create(0, 0), doc.positionAt(doc.getText().length));

      const modeRanges = this.languageModes.getModesInRange(doc, fullDocRange);
      const allEdits: TextEdit[] = [];

      const errMessages: string[] = [];

      modeRanges.forEach(range => {
        if (range.mode && range.mode.format) {
          try {
            const edits = range.mode.format(doc, range, options);
            for (const edit of edits) {
              allEdits.push(edit);
            }
          } catch (err) {
            errMessages.push(err.toString());
          }
        }
      });

      if (errMessages.length !== 0) {
        this.displayErrorMessage('Formatting failed: "' + errMessages.join('\n') + '"');
        return [];
      }

      return allEdits;
    }, [], `Error while formatting range for ${textDocument.uri}`, token)
  }

  onCompletion({ textDocument, position }: TextDocumentPositionParams, token: CancellationToken) {
    return runSafeAsync(async () => {
      const doc = this.documentService.getDocument(textDocument.uri)!;
      const mode = this.languageModes.getModeAtPosition(doc, position);
      if (mode && mode.doComplete) {
        return mode.doComplete(doc, position);
      }

      return NULL_COMPLETION;
    }, null, `Error while computing completions for ${textDocument.uri}`, token);
  }

  onCompletionResolve(item: CompletionItem, token: CancellationToken) {
    return runSafeAsync(async () => {
      if (item.data) {
        const { uri, languageId } = item.data;
        if (uri && languageId) {
          const doc = this.documentService.getDocument(uri);
          const mode = this.languageModes.getMode(languageId);
          if (doc && mode && mode.doResolve) {
            return mode.doResolve(doc, item);
          }
        }
      }
      return item;
    }, item, `Error while resolving completion proposal`, token);
  }

  onHover({ textDocument, position }: TextDocumentPositionParams, token: CancellationToken) {
    return runSafeAsync(async () => {
      const doc = this.documentService.getDocument(textDocument.uri)!;
      const mode = this.languageModes.getModeAtPosition(doc, position);
      if (mode && mode.doHover) {
        return mode.doHover(doc, position);
      }
      return NULL_HOVER;
    }, null, `Error while computing hover for ${textDocument.uri}`, token);
  }

  onDocumentHighlight({ textDocument, position }: TextDocumentPositionParams): DocumentHighlight[] {
    const doc = this.documentService.getDocument(textDocument.uri)!;
    const mode = this.languageModes.getModeAtPosition(doc, position);
    if (mode && mode.findDocumentHighlight) {
      return mode.findDocumentHighlight(doc, position);
    }
    return [];
  }

  onDefinition({ textDocument, position }: TextDocumentPositionParams): Definition {
    const doc = this.documentService.getDocument(textDocument.uri)!;
    const mode = this.languageModes.getModeAtPosition(doc, position);
    if (mode && mode.findDefinition) {
      return mode.findDefinition(doc, position);
    }
    return [];
  }

  onReferences({ textDocument, position }: TextDocumentPositionParams): Location[] {
    const doc = this.documentService.getDocument(textDocument.uri)!;
    const mode = this.languageModes.getModeAtPosition(doc, position);
    if (mode && mode.findReferences) {
      return mode.findReferences(doc, position);
    }
    return [];
  }

  onDocumentLinks({ textDocument }: DocumentLinkParams): DocumentLink[] {
    const doc = this.documentService.getDocument(textDocument.uri)!;
    const documentContext: DocumentContext = {
      resolveReference: ref => {
        if (this.workspacePath && ref[0] === '/') {
          return Uri.file(path.resolve(this.workspacePath, ref)).toString();
        }
        const docUri = Uri.parse(doc.uri);
        return docUri
          .with({
            // Reference from components need to go dwon from their parent dir
            path: path.resolve(docUri.fsPath, '..', ref)
          })
          .toString();
      }
    };

    const links: DocumentLink[] = [];
    this.languageModes.getAllModesInDocument(doc).forEach(m => {
      if (m.findDocumentLinks) {
        pushAll(links, m.findDocumentLinks(doc, documentContext));
      }
    });
    return links;
  }

  onDocumentSymbol({ textDocument }: DocumentSymbolParams, token: CancellationToken) {
    return runSafeAsync(async () => {
      const doc = this.documentService.getDocument(textDocument.uri)!;
      const symbols: SymbolInformation[] = [];

      this.languageModes.getAllModesInDocument(doc).forEach(m => {
        if (m.findDocumentSymbols) {
          pushAll(symbols, m.findDocumentSymbols(doc));
        }
      });
      return symbols;
    }, [], `Error while computing document symbols for ${textDocument.uri}`, token);
  }

  onDocumentColors({ textDocument }: DocumentColorParams, token: CancellationToken) {
    return runSafeAsync(async () => {
      const doc = this.documentService.getDocument(textDocument.uri)!;
      const colors: ColorInformation[] = [];

      this.languageModes.getAllModesInDocument(doc).forEach(m => {
        if (m.findDocumentColors) {
          pushAll(colors, m.findDocumentColors(doc));
        }
      });
      return colors;
    }, [], `Error while computing document colors for ${textDocument.uri}`, token);
  }

  onColorPresentations({ textDocument, color, range }: ColorPresentationParams, token: CancellationToken) {
    return runSafeAsync(async () => {
      const doc = this.documentService.getDocument(textDocument.uri)!;
      const mode = this.languageModes.getModeAtPosition(doc, range.start);
      if (mode && mode.getColorPresentations) {
        return mode.getColorPresentations(doc, color, range);
      }
      return [];
    }, [], `Error while computing color presentations for ${textDocument.uri}`, token);
  }

  onSignatureHelp({ textDocument, position }: TextDocumentPositionParams): SignatureHelp | null {
    const doc = this.documentService.getDocument(textDocument.uri)!;
    const mode = this.languageModes.getModeAtPosition(doc, position);
    if (mode && mode.doSignatureHelp) {
      return mode.doSignatureHelp(doc, position);
    }
    return NULL_SIGNATURE;
  }

  /**
   * Validations
   */

  private triggerValidation(textDocument: TextDocument): void {
    this.cleanPendingValidation(textDocument);
    this.pendingValidationRequests[textDocument.uri] = setTimeout(() => {
      delete this.pendingValidationRequests[textDocument.uri];
      this.validateTextDocument(textDocument);
    }, this.validationDelayMs);
  }

  cleanPendingValidation(textDocument: TextDocument): void {
    const request = this.pendingValidationRequests[textDocument.uri];
    if (request) {
      clearTimeout(request);
      delete this.pendingValidationRequests[textDocument.uri];
    }
  }

  validateTextDocument(textDocument: TextDocument): void {
    if (textDocument.getText().length === 0) {
      // ignore empty documents
      this.lspConnection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
      return;
    }
    const diagnostics: Diagnostic[] = this.doValidate(textDocument);
    this.lspConnection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
  }

  doValidate(doc: TextDocument): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const self = this;
    if (doc.languageId === 'vue') {
      this.languageModes.getAllModesInDocument(doc).forEach(mode => {
        if (mode.doValidation && self.validation[mode.getId()]) {
          pushAll(diagnostics, mode.doValidation(doc));
        }
      });
    }
    return diagnostics;
  }

  removeDocument(doc: TextDocument): void {
    this.languageModes.onDocumentRemoved(doc);
  }

  dispose(): void {
    this.languageModes.dispose();
  }

  get capabilities(): ServerCapabilities {
    return {
      textDocumentSync: TextDocumentSyncKind.Full,
      completionProvider: { resolveProvider: true, triggerCharacters: ['.', ':', '<', '"', "'", '/', '@', '*'] },
      signatureHelpProvider: { triggerCharacters: ['('] },
      documentFormattingProvider: true,
      hoverProvider: true,
      documentHighlightProvider: true,
      documentLinkProvider: {
        resolveProvider: false
      },
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      colorProvider: true
    };
  }
}

function pushAll<T>(to: T[], from: T[]) {
  if (from) {
    for (let i = 0; i < from.length; i++) {
      to.push(from[i]);
    }
  }
}
