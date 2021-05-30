/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { createCancelablePromise, RunOnceScheduler } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { onUnexpectedError, onUnexpectedExternalError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import * as strings from '../../../base/common/strings.js';
import { Range } from '../../common/core/range.js';
import { InlineCompletionsProviderRegistry, InlineCompletionTriggerKind } from '../../common/modes.js';
import { BaseGhostTextWidgetModel } from './ghostTextWidget.js';
import { EditOperation } from '../../common/core/editOperation.js';
export class InlineCompletionsModel extends Disposable {
    constructor(editor, commandService) {
        super();
        this.editor = editor;
        this.commandService = commandService;
        this.onDidChangeEmitter = new Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.completionSession = this._register(new MutableDisposable());
        this.active = false;
        this._register(this.editor.onDidChangeModelContent((e) => {
            if (this.session && !this.session.isValid) {
                this.hide();
            }
            setTimeout(() => {
                // Wait for the cursor update that happens in the same iteration loop iteration
                this.startSessionIfTriggered();
            }, 0);
        }));
        this._register(this.editor.onDidChangeCursorPosition((e) => {
            if (this.session && !this.session.isValid) {
                this.hide();
            }
        }));
    }
    get session() {
        return this.completionSession.value;
    }
    get ghostText() {
        var _a;
        return (_a = this.session) === null || _a === void 0 ? void 0 : _a.ghostText;
    }
    get minReservedLineCount() {
        return this.session ? this.session.minReservedLineCount : 0;
    }
    get expanded() {
        return this.session ? this.session.expanded : false;
    }
    setExpanded(expanded) {
        var _a;
        (_a = this.session) === null || _a === void 0 ? void 0 : _a.setExpanded(expanded);
    }
    setActive(active) {
        var _a;
        this.active = active;
        if (active) {
            (_a = this.session) === null || _a === void 0 ? void 0 : _a.scheduleAutomaticUpdate();
        }
    }
    startSessionIfTriggered() {
        const suggestOptions = this.editor.getOption(103 /* suggest */);
        if (!suggestOptions.showInlineCompletions) {
            return;
        }
        if (this.session && this.session.isValid) {
            return;
        }
        this.startSession();
    }
    startSession() {
        if (this.completionSession.value) {
            return;
        }
        this.completionSession.value = new InlineCompletionsSession(this.editor, this.editor.getPosition(), () => this.active, this.commandService);
        this.completionSession.value.takeOwnership(this.completionSession.value.onDidChange(() => {
            this.onDidChangeEmitter.fire();
        }));
    }
    hide() {
        this.completionSession.clear();
        this.onDidChangeEmitter.fire();
    }
    commitCurrentSuggestion() {
        var _a;
        (_a = this.session) === null || _a === void 0 ? void 0 : _a.commitCurrentCompletion();
    }
    showNext() {
        var _a;
        (_a = this.session) === null || _a === void 0 ? void 0 : _a.showNextInlineCompletion();
    }
    showPrevious() {
        var _a;
        (_a = this.session) === null || _a === void 0 ? void 0 : _a.showPreviousInlineCompletion();
    }
}
class InlineCompletionsSession extends BaseGhostTextWidgetModel {
    constructor(editor, triggerPosition, shouldUpdate, commandService) {
        super(editor);
        this.triggerPosition = triggerPosition;
        this.shouldUpdate = shouldUpdate;
        this.commandService = commandService;
        this.minReservedLineCount = 0;
        this.updateOperation = this._register(new MutableDisposable());
        this.cache = this._register(new MutableDisposable());
        this.updateSoon = this._register(new RunOnceScheduler(() => this.update(InlineCompletionTriggerKind.Automatic), 50));
        this.textModel = this.editor.getModel();
        //#region Selection
        // We use a semantic id to track the selection even if the cache changes.
        this.currentlySelectedCompletionId = undefined;
        let lastCompletionItem = undefined;
        this._register(this.onDidChange(() => {
            const currentCompletion = this.currentCompletion;
            if (currentCompletion && currentCompletion.sourceInlineCompletion !== lastCompletionItem) {
                lastCompletionItem = currentCompletion.sourceInlineCompletion;
                const provider = currentCompletion.sourceProvider;
                if (provider.handleItemDidShow) {
                    provider.handleItemDidShow(currentCompletion.sourceInlineCompletions, lastCompletionItem);
                }
            }
        }));
        this._register(this.editor.onDidChangeModelContent((e) => {
            if (this.cache.value) {
                let hasChanged = false;
                for (const c of this.cache.value.completions) {
                    const newRange = this.textModel.getDecorationRange(c.decorationId);
                    if (!newRange) {
                        onUnexpectedError(new Error('Decoration has no range'));
                        continue;
                    }
                    if (!c.synchronizedRange.equalsRange(newRange)) {
                        hasChanged = true;
                        c.synchronizedRange = newRange;
                    }
                }
                if (hasChanged) {
                    this.onDidChangeEmitter.fire();
                }
            }
            this.scheduleAutomaticUpdate();
        }));
        this.scheduleAutomaticUpdate();
    }
    fixAndGetIndexOfCurrentSelection() {
        if (!this.currentlySelectedCompletionId || !this.cache.value) {
            return 0;
        }
        if (this.cache.value.completions.length === 0) {
            // don't reset the selection in this case
            return 0;
        }
        const idx = this.cache.value.completions.findIndex(v => v.semanticId === this.currentlySelectedCompletionId);
        if (idx === -1) {
            // Reset the selection so that the selection does not jump back when it appears again
            this.currentlySelectedCompletionId = undefined;
            return 0;
        }
        return idx;
    }
    get currentCachedCompletion() {
        if (!this.cache.value) {
            return undefined;
        }
        return this.cache.value.completions[this.fixAndGetIndexOfCurrentSelection()];
    }
    showNextInlineCompletion() {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureUpdateWithExplicitContext();
            const completions = ((_a = this.cache.value) === null || _a === void 0 ? void 0 : _a.completions) || [];
            if (completions.length > 0) {
                const newIdx = (this.fixAndGetIndexOfCurrentSelection() + 1) % completions.length;
                this.currentlySelectedCompletionId = completions[newIdx].semanticId;
            }
            else {
                this.currentlySelectedCompletionId = undefined;
            }
            this.onDidChangeEmitter.fire();
        });
    }
    showPreviousInlineCompletion() {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureUpdateWithExplicitContext();
            const completions = ((_a = this.cache.value) === null || _a === void 0 ? void 0 : _a.completions) || [];
            if (completions.length > 0) {
                const newIdx = (this.fixAndGetIndexOfCurrentSelection() + completions.length - 1) % completions.length;
                this.currentlySelectedCompletionId = completions[newIdx].semanticId;
            }
            else {
                this.currentlySelectedCompletionId = undefined;
            }
            this.onDidChangeEmitter.fire();
        });
    }
    ensureUpdateWithExplicitContext() {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            if (this.updateOperation.value) {
                // Restart or wait for current update operation
                if (this.updateOperation.value.triggerKind === InlineCompletionTriggerKind.Explicit) {
                    yield this.updateOperation.value.promise;
                }
                else {
                    yield this.update(InlineCompletionTriggerKind.Explicit);
                }
            }
            else if (((_a = this.cache.value) === null || _a === void 0 ? void 0 : _a.triggerKind) !== InlineCompletionTriggerKind.Explicit) {
                // Refresh cache
                yield this.update(InlineCompletionTriggerKind.Explicit);
            }
        });
    }
    //#endregion
    get ghostText() {
        const currentCompletion = this.currentCompletion;
        return currentCompletion ? inlineCompletionToGhostText(currentCompletion, this.editor.getModel()) : undefined;
    }
    get currentCompletion() {
        const completion = this.currentCachedCompletion;
        if (!completion) {
            return undefined;
        }
        return {
            text: completion.inlineCompletion.text,
            range: completion.synchronizedRange,
            command: completion.inlineCompletion.command,
            sourceProvider: completion.inlineCompletion.sourceProvider,
            sourceInlineCompletions: completion.inlineCompletion.sourceInlineCompletions,
            sourceInlineCompletion: completion.inlineCompletion.sourceInlineCompletion,
        };
    }
    get isValid() {
        return this.editor.getPosition().lineNumber === this.triggerPosition.lineNumber;
    }
    scheduleAutomaticUpdate() {
        this.updateSoon.schedule();
    }
    update(triggerKind) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.shouldUpdate()) {
                return;
            }
            const position = this.editor.getPosition();
            const promise = createCancelablePromise((token) => __awaiter(this, void 0, void 0, function* () {
                let result;
                try {
                    result = yield provideInlineCompletions(position, this.editor.getModel(), { triggerKind }, token);
                }
                catch (e) {
                    onUnexpectedError(e);
                    return;
                }
                if (token.isCancellationRequested) {
                    return;
                }
                this.cache.value = new SynchronizedInlineCompletionsCache(this.editor, result, () => this.onDidChangeEmitter.fire(), triggerKind);
                this.onDidChangeEmitter.fire();
            }));
            const operation = new UpdateOperation(promise, triggerKind);
            this.updateOperation.value = operation;
            yield promise;
            if (this.updateOperation.value === operation) {
                this.updateOperation.clear();
            }
        });
    }
    takeOwnership(disposable) {
        this._register(disposable);
    }
    commitCurrentCompletion() {
        const completion = this.currentCompletion;
        if (completion) {
            this.commit(completion);
        }
    }
    commit(completion) {
        this.cache.clear();
        this.editor.executeEdits('inlineCompletions.accept', [
            EditOperation.replaceMove(completion.range, completion.text)
        ]);
        if (completion.command) {
            this.commandService.executeCommand(completion.command.id, ...(completion.command.arguments || [])).then(undefined, onUnexpectedExternalError);
        }
        this.onDidChangeEmitter.fire();
    }
}
class UpdateOperation {
    constructor(promise, triggerKind) {
        this.promise = promise;
        this.triggerKind = triggerKind;
    }
    dispose() {
        this.promise.cancel();
    }
}
/**
 * The cache keeps itself in sync with the editor.
 * It also owns the completions result and disposes it when the cache is diposed.
*/
class SynchronizedInlineCompletionsCache extends Disposable {
    constructor(editor, completionsSource, onChange, triggerKind) {
        super();
        this.triggerKind = triggerKind;
        const decorationIds = editor.deltaDecorations([], completionsSource.items.map(i => ({
            range: i.range,
            options: {
                description: 'inline-completion-tracking-range'
            },
        })));
        this._register(toDisposable(() => {
            editor.deltaDecorations(decorationIds, []);
        }));
        this.completions = completionsSource.items.map((c, idx) => new CachedInlineCompletion(c, decorationIds[idx]));
        this._register(editor.onDidChangeModelContent(() => {
            let hasChanged = false;
            const model = editor.getModel();
            for (const c of this.completions) {
                const newRange = model.getDecorationRange(c.decorationId);
                if (!newRange) {
                    onUnexpectedError(new Error('Decoration has no range'));
                    continue;
                }
                if (!c.synchronizedRange.equalsRange(newRange)) {
                    hasChanged = true;
                    c.synchronizedRange = newRange;
                }
            }
            if (hasChanged) {
                onChange();
            }
        }));
        this._register(completionsSource);
    }
}
class CachedInlineCompletion {
    constructor(inlineCompletion, decorationId) {
        this.inlineCompletion = inlineCompletion;
        this.decorationId = decorationId;
        this.semanticId = JSON.stringify({
            text: this.inlineCompletion.text,
            startLine: this.inlineCompletion.range.startLineNumber,
            startColumn: this.inlineCompletion.range.startColumn,
            command: this.inlineCompletion.command
        });
        this.synchronizedRange = inlineCompletion.range;
    }
}
export function inlineCompletionToGhostText(inlineCompletion, textModel) {
    const valueToBeReplaced = textModel.getValueInRange(inlineCompletion.range);
    if (!inlineCompletion.text.startsWith(valueToBeReplaced)) {
        return undefined;
    }
    const lines = strings.splitLines(inlineCompletion.text.substr(valueToBeReplaced.length));
    return {
        lines,
        position: inlineCompletion.range.getEndPosition()
    };
}
function getDefaultRange(position, model) {
    const word = model.getWordAtPosition(position);
    const maxColumn = model.getLineMaxColumn(position.lineNumber);
    // By default, always replace up until the end of the current line.
    // This default might be subject to change!
    return word
        ? new Range(position.lineNumber, word.startColumn, position.lineNumber, maxColumn)
        : Range.fromPositions(position, position.with(undefined, maxColumn));
}
function provideInlineCompletions(position, model, context, token = CancellationToken.None) {
    return __awaiter(this, void 0, void 0, function* () {
        const defaultReplaceRange = getDefaultRange(position, model);
        const providers = InlineCompletionsProviderRegistry.all(model);
        const results = yield Promise.all(providers.map((provider) => __awaiter(this, void 0, void 0, function* () {
            const completions = yield provider.provideInlineCompletions(model, position, context, token);
            return ({
                completions,
                provider,
                dispose: () => {
                    if (completions) {
                        provider.freeInlineCompletions(completions);
                    }
                }
            });
        })));
        const itemsByHash = new Map();
        for (const result of results) {
            const completions = result.completions;
            if (completions) {
                for (const item of completions.items.map(item => ({
                    text: item.text,
                    range: item.range ? Range.lift(item.range) : defaultReplaceRange,
                    command: item.command,
                    sourceProvider: result.provider,
                    sourceInlineCompletions: completions,
                    sourceInlineCompletion: item
                }))) {
                    itemsByHash.set(JSON.stringify({ text: item.text, range: item.range }), item);
                }
            }
        }
        return {
            items: [...itemsByHash.values()],
            dispose: () => {
                for (const result of results) {
                    result.dispose();
                }
            },
        };
    });
}
