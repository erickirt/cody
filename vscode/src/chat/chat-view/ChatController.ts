import {
    type AuthCredentials,
    type AuthStatus,
    type BillingCategory,
    type BillingProduct,
    CHAT_OUTPUT_TOKEN_BUDGET,
    type ChatClient,
    type ChatMessage,
    type ChatModel,
    type ClientActionBroadcast,
    ClientConfigSingleton,
    type CodyClientConfig,
    type ContextItem,
    ContextItemSource,
    type CurrentUserCodySubscription,
    DOTCOM_URL,
    type DefaultChatCommands,
    type EventSource,
    FeatureFlag,
    GuardrailsMode,
    ModelTag,
    ModelUsage,
    type ProcessingStep,
    PromptString,
    type RateLimitError,
    type SerializedChatInteraction,
    type SerializedChatTranscript,
    type SerializedPromptEditorState,
    type SourcegraphGuardrailsClient,
    addMessageListenersForExtensionAPI,
    authStatus,
    cenv,
    clientCapabilities,
    createMessageAPIForExtension,
    currentAuthStatus,
    currentAuthStatusAuthed,
    currentResolvedConfig,
    currentUserProductSubscription,
    distinctUntilChanged,
    extractContextFromTraceparent,
    featureFlagProvider,
    firstResultFromOperation,
    firstValueFrom,
    forceHydration,
    getDefaultSystemPrompt,
    graphqlClient,
    handleRateLimitError,
    hydrateAfterPostMessage,
    isAbortErrorOrSocketHangUp,
    isContextWindowLimitError,
    isDefined,
    isDotCom,
    isError,
    isRateLimitError,
    isS2,
    logError,
    modelsService,
    pendingOperation,
    promiseFactoryToObservable,
    ps,
    recordErrorToSpan,
    reformatBotMessageForChat,
    resolvedConfig,
    serializeChatMessage,
    serializeContextItem,
    shareReplay,
    skip,
    skipPendingOperation,
    startWith,
    subscriptionDisposable,
    switchMap,
    telemetryRecorder,
    tracer,
    truncatePromptString,
    userProductSubscription,
    wrapInActiveSpan,
} from '@sourcegraph/cody-shared'
import * as uuid from 'uuid'
import * as vscode from 'vscode'

import { type Span, context } from '@opentelemetry/api'
import { captureException } from '@sentry/core'
import { ChatHistoryType } from '@sourcegraph/cody-shared/src/chat/transcript'
import type { SubMessage } from '@sourcegraph/cody-shared/src/chat/transcript/messages'
import { resolveAuth } from '@sourcegraph/cody-shared/src/configuration/auth-resolver'
import type { McpServer } from '@sourcegraph/cody-shared/src/llm-providers/mcp/types'
import type { TelemetryEventParameters } from '@sourcegraph/telemetry'
import { Observable, Subject, map } from 'observable-fns'
import type { URI } from 'vscode-uri'
import { View } from '../../../webviews/tabs/types'
import { redirectToEndpointLogin, showSignInMenu, showSignOutMenu, signOut } from '../../auth/auth'
import {
    closeAuthProgressIndicator,
    startAuthProgressIndicator,
} from '../../auth/auth-progress-indicator'
import type { startTokenReceiver } from '../../auth/token-receiver'
import { getCurrentUserId } from '../../auth/user'
import { getContextFileFromUri } from '../../commands/context/file-path'
import { getContextFileFromCursor } from '../../commands/context/selection'
import {
    getFrequentlyUsedContextItems,
    saveFrequentlyUsedContextItems,
} from '../../context/frequentlyUsed'
import { getEditor } from '../../editor/active-editor'
import type { VSCodeEditor } from '../../editor/vscode-editor'
import type { ExtensionClient } from '../../extension-client'
import { migrateAndNotifyForOutdatedModels } from '../../models/modelMigrator'
import { logDebug, outputChannelLogger } from '../../output-channel-logger'
import { hydratePromptText } from '../../prompts/prompt-hydration'
import { listPromptTags, mergedPromptsAndLegacyCommands } from '../../prompts/prompts'
import { workspaceFolderForRepo } from '../../repository/remoteRepos'
import { repoNameResolver } from '../../repository/repo-name-resolver'
import { authProvider } from '../../services/AuthProvider'
import { AuthProviderSimplified } from '../../services/AuthProviderSimplified'
import { localStorage } from '../../services/LocalStorageProvider'
import { secretStorage } from '../../services/SecretStorageProvider'
import { TraceSender } from '../../services/open-telemetry/trace-sender'
import {
    handleCodeFromInsertAtCursor,
    handleCodeFromSaveToNewFile,
    handleCopiedCode,
    handleSmartApply,
} from '../../services/utils/codeblock-action-tracker'
import { openExternalLinks } from '../../services/utils/workspace-action'
import { TestSupport } from '../../test-support'
import type { MessageErrorType } from '../MessageProvider'
import { DeepCodyAgent } from '../agentic/DeepCody'
import { getMentionMenuData } from '../context/chatContext'
import { getEmptyOrDefaultContextObservable } from '../initialContext'
import type {
    ConfigurationSubsetForWebview,
    ExtensionMessage,
    LocalEnv,
    SmartApplyResult,
    WebviewMessage,
} from '../protocol'
import { countGeneratedCode } from '../utils'
import { ChatBuilder, prepareChatMessage } from './ChatBuilder'
import { chatHistory } from './ChatHistoryManager'
import { CodyChatEditorViewType } from './ChatsController'
import { CodeBlockRegenerator, type RegenerateRequestParams } from './CodeBlockRegenerator'
import type { ContextRetriever } from './ContextRetriever'
import { InitDoer } from './InitDoer'
import { getChatPanelTitle, isCodyTesting } from './chat-helpers'
import { DeepCodyHandler } from './handlers/DeepCodyHandler'
import { OmniboxTelemetry } from './handlers/OmniboxTelemetry'
import { getAgent } from './handlers/registry'
import { getPromptsMigrationInfo, startPromptsMigration } from './prompts-migration'
import { MCPManager } from './tools/MCPManager'

export interface ChatControllerOptions {
    extensionUri: vscode.Uri
    chatClient: Pick<ChatClient, 'chat'>
    contextRetriever: Pick<ContextRetriever, 'retrieveContext'>
    extensionClient: Pick<ExtensionClient, 'capabilities'>
    editor: VSCodeEditor
    guardrails: SourcegraphGuardrailsClient
    startTokenReceiver?: typeof startTokenReceiver
}

export interface ChatSession {
    webviewPanelOrView: vscode.WebviewView | vscode.WebviewPanel | undefined
    sessionID: string
}

/**
 * ChatController is the view controller class for the chat panel.
 * It handles all events sent from the view, keeps track of the underlying chat model,
 * and interacts with the rest of the extension.
 *
 * Its methods are grouped into the following sections, each of which is demarcated
 * by a comment block (search for "// #region "):
 *
 * 1. top-level view action handlers
 * 2. view updaters
 * 3. chat request lifecycle methods
 * 4. session management
 * 5. webview container management
 * 6. other public accessors and mutators
 *
 * The following invariants should be maintained:
 * 1. top-level view action handlers
 *    a. should all follow the handle$ACTION naming convention
 *    b. should be private (with the existing exceptions)
 * 2. view updaters
 *    a. should all follow the post$ACTION naming convention
 *    b. should NOT mutate model state
 * 3. Keep the public interface of this class small in order to
 *    avoid tight coupling with other classes. If communication
 *    with other components outside the model and view is needed,
 *    use a broadcast/subscription design.
 */
export class ChatController implements vscode.Disposable, vscode.WebviewViewProvider, ChatSession {
    private chatBuilder: ChatBuilder

    private readonly chatClient: ChatControllerOptions['chatClient']

    private readonly contextRetriever: ChatControllerOptions['contextRetriever']

    private readonly editor: ChatControllerOptions['editor']
    private readonly extensionClient: ChatControllerOptions['extensionClient']
    private readonly guardrails: SourcegraphGuardrailsClient

    private readonly startTokenReceiver: typeof startTokenReceiver | undefined

    private lastKnownTokenUsage:
        | {
              completionTokens?: number
              promptTokens?: number
              totalTokens?: number
          }
        | undefined = undefined

    private disposables: vscode.Disposable[] = []

    public readonly clientBroadcast = new Subject<ClientActionBroadcast>()

    public dispose(): void {
        vscode.Disposable.from(...this.disposables).dispose()
        this.disposables = []
    }

    constructor({
        extensionUri,
        chatClient,
        editor,
        guardrails,
        startTokenReceiver,
        contextRetriever,
        extensionClient,
    }: ChatControllerOptions) {
        this.extensionUri = extensionUri
        this.chatClient = chatClient
        this.editor = editor
        this.extensionClient = extensionClient
        this.contextRetriever = contextRetriever

        this.chatBuilder = new ChatBuilder(undefined)

        this.guardrails = guardrails
        this.startTokenReceiver = startTokenReceiver

        if (TestSupport.instance) {
            TestSupport.instance.chatPanelProvider.set(this)
        }

        this.disposables.push(
            subscriptionDisposable(
                authStatus.subscribe(authStatus => {
                    // Run this async because this method may be called during initialization
                    // and awaiting on this.postMessage may result in a deadlock
                    void this.sendConfig(authStatus)
                })
            ),
            subscriptionDisposable(
                ClientConfigSingleton.getInstance().updates.subscribe(update => {
                    // Run this async because this method may be called during initialization
                    // and awaiting on this.postMessage may result in a deadlock
                    void this.sendClientConfig(update)
                })
            ),

            // Reset the chat when the endpoint changes so that we don't try to use old models.
            subscriptionDisposable(
                authStatus
                    .pipe(
                        map(authStatus => authStatus.endpoint),
                        distinctUntilChanged(),
                        // Skip the initial emission (which occurs immediately upon subscription)
                        // because we only want to reset it when it changes after the ChatController
                        // has been in use. If we didn't have `skip(1)`, then `new
                        // ChatController().restoreSession(...)` usage would break because we would
                        // immediately overwrite the just-restored chat.
                        skip(1)
                    )
                    .subscribe(() => {
                        this.chatBuilder = new ChatBuilder(undefined)
                    })
            )
        )
    }

    /**
     * onDidReceiveMessage handles all user actions sent from the chat panel view.
     * @param message is the message from the view.
     */
    private async onDidReceiveMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.command) {
                case 'ready':
                    await this.handleReady()
                    break
                case 'initialized':
                    await this.handleInitialized()
                    this.setWebviewToChat()
                    break
                case 'submit': {
                    await this.handleUserMessage({
                        requestID: uuid.v4(),
                        inputText: PromptString.unsafe_fromUserQuery(message.text),
                        mentions: message.contextItems ?? [],
                        editorState: message.editorState as SerializedPromptEditorState,
                        signal: this.startNewSubmitOrEditOperation(),
                        source: 'chat',
                        manuallySelectedIntent: message.manuallySelectedIntent,
                        traceparent: message.traceparent,
                    })
                    break
                }
                case 'edit': {
                    this.cancelSubmitOrEditOperation()

                    await this.handleEdit({
                        requestID: uuid.v4(),
                        text: PromptString.unsafe_fromUserQuery(message.text),
                        index: message.index ?? undefined,
                        contextFiles: message.contextItems ?? [],
                        editorState: message.editorState as SerializedPromptEditorState,
                        manuallySelectedIntent: message.manuallySelectedIntent,
                    })
                    break
                }
                case 'abort':
                    this.handleAbort()
                    break
                case 'insert':
                    await handleCodeFromInsertAtCursor(message.text)
                    break
                case 'copy':
                    await handleCopiedCode(message.text, message.eventType)
                    break
                case 'smartApplyPrefetch':
                case 'smartApplySubmit':
                    await handleSmartApply({
                        id: message.id,
                        code: message.code,
                        authStatus: currentAuthStatus(),
                        instruction: message.instruction || '',
                        fileUri: message.fileName,
                        traceparent: message.traceparent || undefined,
                        isPrefetch: message.command === 'smartApplyPrefetch',
                    })
                    break
                case 'trace-export':
                    TraceSender.send(message.traceSpanEncodedJson)
                    break
                case 'smartApplyAccept':
                    await vscode.commands.executeCommand('cody.command.smart-apply.accept', {
                        taskId: message.id,
                    })
                    break
                case 'smartApplyReject':
                    await vscode.commands.executeCommand('cody.command.smart-apply.reject', {
                        taskId: message.id,
                    })
                    break
                case 'openURI':
                    vscode.commands.executeCommand('vscode.open', message.uri, {
                        selection: message.range,
                    })
                    break
                case 'links': {
                    void openExternalLinks(message.value)
                    break
                }
                case 'openFileLink':
                    {
                        if (message?.uri?.scheme?.startsWith('http')) {
                            this.openRemoteFile(message.uri, true)
                            return
                        }

                        // Determine if we're in the sidebar view
                        const isInSidebar =
                            this._webviewPanelOrView && !('viewColumn' in this._webviewPanelOrView)

                        vscode.commands.executeCommand('vscode.open', message.uri, {
                            selection: message.range,
                            preserveFocus: true,
                            background: false,
                            preview: true,
                            // Use the active column if in sidebar, otherwise use Beside
                            viewColumn: isInSidebar
                                ? vscode.ViewColumn.Active
                                : vscode.ViewColumn.Beside,
                        })
                    }
                    break
                case 'openRemoteFile':
                    this.openRemoteFile(message.uri, message.tryLocal ?? false)
                    break
                case 'newFile':
                    await handleCodeFromSaveToNewFile(message.text, this.editor)
                    break
                case 'show-page':
                    await vscode.commands.executeCommand('cody.show-page', message.page)
                    break
                case 'attribution-search':
                    await this.handleAttributionSearch(message.snippet)
                    break
                case 'restoreHistory':
                    this.restoreSession(message.chatID)
                    this.setWebviewToChat()
                    break
                case 'chatSession':
                    switch (message.action) {
                        case 'new':
                            this.clearAndRestartSession()
                            break
                        case 'duplicate':
                            await this.duplicateSession(message.sessionID ?? this.chatBuilder.sessionID)
                            break
                    }
                    break
                case 'command':
                    vscode.commands.executeCommand(message.id, message.arg ?? message.args)
                    break
                case 'mcp': {
                    const mcpManager = MCPManager.instance
                    if (!mcpManager) {
                        logDebug('ChatController', 'MCP Manager is not initialized')
                        break
                    }
                    const serverName = message.name
                    try {
                        // Special case for updateServer without name (to refresh server list)
                        if (message.type === 'updateServer' && !serverName) {
                            mcpManager.refreshServers()
                            break
                        }
                        // All other operations require a server name
                        if (!serverName) {
                            break
                        }
                        switch (message.type) {
                            case 'addServer': {
                                if (!message.config) {
                                    break
                                }
                                await mcpManager.addServer(serverName, message.config)
                                // Send specific message to the UI about the new server
                                const newServer = mcpManager
                                    .getServers()
                                    .find(s => s.name === serverName)
                                if (newServer) {
                                    void this.postMessage({
                                        type: 'clientAction',
                                        mcpServerChanged: {
                                            name: newServer.name,
                                            server: newServer,
                                        },
                                    })
                                }
                                break
                            }
                            case 'updateServer':
                                if (message.config) {
                                    await mcpManager.updateServer(serverName, message.config)
                                } else if (message.toolName) {
                                    const isDisabled = message.toolDisabled === true
                                    await mcpManager.setToolState(
                                        serverName,
                                        message.toolName,
                                        isDisabled
                                    )
                                }
                                break
                            case 'removeServer': {
                                await mcpManager.deleteServer(serverName)
                                this.postMessage({
                                    type: 'clientAction',
                                    mcpServerChanged: {
                                        name: serverName,
                                        server: null,
                                    },
                                })
                                break
                            }
                            default:
                                logDebug('ChatController', `Unknown MCP operation: ${message.type}`)
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error)
                        logDebug('ChatController', `Failed to ${message.type} server`, errorMessage)

                        void this.postMessage({
                            type: 'clientAction',
                            mcpServerError: {
                                name: 'name' in message ? serverName : '',
                                error: errorMessage,
                            },
                            mcpServerChanged: null,
                        })
                    }
                    break
                }

                case 'recordEvent':
                    telemetryRecorder.recordEvent(
                        // 👷 HACK: We have no control over what gets sent over JSON RPC,
                        // so we depend on client implementations to give type guidance
                        // to ensure that we don't accidentally share arbitrary,
                        // potentially sensitive string values. In this RPC handler,
                        // when passing the provided event to the TelemetryRecorder
                        // implementation, we forcibly cast all the inputs below
                        // (feature, action, parameters) into known types (strings
                        // 'feature', 'action', 'key') so that the recorder will accept
                        // it. DO NOT do this elsewhere!
                        message.feature as 'feature',
                        message.action as 'action',
                        message.parameters as TelemetryEventParameters<
                            { key: number },
                            BillingProduct,
                            BillingCategory
                        >
                    )
                    break
                case 'auth': {
                    if (message.authKind === 'refresh') {
                        authProvider.refresh()
                        break
                    }
                    if (message.authKind === 'simplified-onboarding') {
                        const endpoint = DOTCOM_URL.href

                        let tokenReceiverUrl: string | undefined = undefined
                        closeAuthProgressIndicator()
                        startAuthProgressIndicator()
                        tokenReceiverUrl = await this.startTokenReceiver?.(
                            endpoint,
                            async credentials => {
                                closeAuthProgressIndicator()
                                const authStatus = await authProvider.validateAndStoreCredentials(
                                    credentials,
                                    'store-if-valid'
                                )
                                telemetryRecorder.recordEvent(
                                    'cody.auth.fromTokenReceiver.web',
                                    'succeeded',
                                    {
                                        metadata: {
                                            success: authStatus.authenticated ? 1 : 0,
                                        },
                                        billingMetadata: {
                                            product: 'cody',
                                            category: 'billable',
                                        },
                                    }
                                )
                                if (!authStatus.authenticated) {
                                    void vscode.window.showErrorMessage(
                                        'Authentication failed. Please check your token and try again.'
                                    )
                                }
                            }
                        )

                        const authProviderSimplified = new AuthProviderSimplified()
                        const authMethod = message.authMethod || 'dotcom'
                        const successfullyOpenedUrl = await authProviderSimplified.openExternalAuthUrl(
                            authMethod,
                            tokenReceiverUrl
                        )
                        if (!successfullyOpenedUrl) {
                            closeAuthProgressIndicator()
                        }
                        break
                    }
                    if (
                        (message.authKind === 'signin' || message.authKind === 'callback') &&
                        message.endpoint
                    ) {
                        try {
                            const { endpoint, value: token } = message
                            let auth: AuthCredentials | undefined = undefined

                            if (token) {
                                auth = {
                                    credentials: { token, source: 'paste' },
                                    serverEndpoint: endpoint,
                                }
                            } else {
                                const { configuration } = await currentResolvedConfig()
                                auth = await resolveAuth(endpoint, configuration, secretStorage)
                            }

                            if (!auth || !auth.credentials) {
                                return redirectToEndpointLogin(endpoint)
                            }

                            await authProvider.validateAndStoreCredentials(auth, 'always-store')
                        } catch (error) {
                            void vscode.window.showErrorMessage(`Authentication failed: ${error}`)
                            this.postError(new Error(`Authentication failed: ${error}`))
                        }
                        break
                    }
                    if (message.authKind === 'signout') {
                        const serverEndpoint = message.endpoint
                        if (serverEndpoint) {
                            await signOut(serverEndpoint)
                        } else {
                            await showSignOutMenu()
                        }
                        // Send config to refresh the endpoint history list.
                        // TODO: Remove this when the config for webview is observable, see getConfigForWebview.
                        await this.sendConfig(currentAuthStatus())
                        break
                    }
                    if (message.authKind === 'switch') {
                        await showSignInMenu()
                        break
                    }
                    // cody.auth.signin or cody.auth.signout
                    await vscode.commands.executeCommand(`cody.auth.${message.authKind}`)
                    break
                }
                case 'simplified-onboarding': {
                    if (message.onboardingKind === 'web-sign-in-token') {
                        void vscode.window
                            .showInputBox({ prompt: 'Enter web sign-in token' })
                            .then(async token => {
                                if (!token) {
                                    return
                                }
                                const authStatus = await authProvider.validateAndStoreCredentials(
                                    {
                                        serverEndpoint: DOTCOM_URL.href,
                                        credentials: { token },
                                    },
                                    'store-if-valid'
                                )
                                if (!authStatus.authenticated) {
                                    void vscode.window.showErrorMessage(
                                        'Authentication failed. Please check your token and try again.'
                                    )
                                }
                            })
                        break
                    }
                    break
                }
                case 'log': {
                    const logger = message.level === 'debug' ? logDebug : logError
                    logger(message.filterLabel, message.message)
                    break
                }
                case 'devicePixelRatio': {
                    localStorage.setDevicePixelRatio(message.devicePixelRatio)
                    break
                }
                case 'regenerateCodeBlock': {
                    await this.handleRegenerateCodeBlock({
                        requestID: message.id,
                        code: PromptString.unsafe_fromLLMResponse(message.code),
                        language: message.language
                            ? PromptString.unsafe_fromLLMResponse(message.language)
                            : undefined,
                        index: message.index,
                    })
                    break
                }
            }
        } catch (error) {
            this.postError(error as Error)
        }
    }

    private isSmartApplyEnabled(): boolean {
        return this.extensionClient.capabilities?.edit !== 'none'
    }

    private hasEditCapability(): boolean {
        return this.extensionClient.capabilities?.edit === 'enabled'
    }

    private async getConfigForWebview(): Promise<ConfigurationSubsetForWebview & LocalEnv> {
        const { configuration, auth } = await currentResolvedConfig()
        const [experimentalPromptEditorEnabled, internalAgentModeEnabled] = await Promise.all([
            firstValueFrom(
                featureFlagProvider.evaluatedFeatureFlag(FeatureFlag.CodyExperimentalPromptEditor)
            ),
            firstValueFrom(
                featureFlagProvider.evaluatedFeatureFlag(FeatureFlag.NextAgenticChatInternal)
            ),
        ])
        const experimentalAgenticChatEnabled = internalAgentModeEnabled && isS2(auth.serverEndpoint)
        const sidebarViewOnly = this.extensionClient.capabilities?.webviewNativeConfig?.view === 'single'
        const isEditorViewType = this.webviewPanelOrView?.viewType === 'cody.editorPanel'
        const webviewType = isEditorViewType && !sidebarViewOnly ? 'editor' : 'sidebar'
        const uiKindIsWeb = (cenv.CODY_OVERRIDE_UI_KIND ?? vscode.env.uiKind) === vscode.UIKind.Web
        const endpoints = localStorage.getEndpointHistory() ?? []
        const attribution =
            (await ClientConfigSingleton.getInstance().getConfig())?.attribution ?? GuardrailsMode.Off

        return {
            uiKindIsWeb,
            serverEndpoint: auth.serverEndpoint,
            endpointHistory: [...endpoints],
            experimentalNoodle: configuration.experimentalNoodle,
            // Disable smart apply codeblock toolbar when agentic chat is enabled.
            smartApply: this.isSmartApplyEnabled(),
            hasEditCapability: this.hasEditCapability(),
            webviewType,
            multipleWebviewsEnabled: !sidebarViewOnly,
            internalDebugContext: configuration.internalDebugContext,
            internalDebugTokenUsage: configuration.internalDebugTokenUsage,
            allowEndpointChange: configuration.overrideServerEndpoint === undefined,
            experimentalPromptEditorEnabled,
            experimentalAgenticChatEnabled,
            attribution,
        }
    }

    // =======================================================================
    // #region top-level view action handlers
    // =======================================================================

    // When the webview sends the 'ready' message, respond by posting the view config
    private async handleReady(): Promise<void> {
        await this.sendConfig(currentAuthStatus())
    }

    private async sendConfig(authStatus: AuthStatus): Promise<void> {
        // Don't emit config if we're verifying auth status to avoid UI auth flashes on the client
        if (authStatus.pendingValidation) {
            return
        }

        const configForWebview = await this.getConfigForWebview()
        const workspaceFolderUris =
            vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ?? []

        // Fetch additional user data if authenticated and not in testing mode
        let siteHasCodyEnabled: boolean | null = null
        let currentUserCodySubscription: CurrentUserCodySubscription | null = null

        if (authStatus.authenticated && !isCodyTesting) {
            try {
                const [siteResult, subscriptionResult] = await Promise.all([
                    graphqlClient.getSiteHasCodyEnabled(),
                    graphqlClient.getCurrentUserCodySubscription(),
                ])

                siteHasCodyEnabled = isError(siteResult) ? null : siteResult
                currentUserCodySubscription = isError(subscriptionResult) ? null : subscriptionResult
            } catch (error) {
                // Log error but don't fail the config send
                console.error('Failed to fetch additional user data', error)
            }
        }

        await this.postMessage({
            type: 'config',
            config: configForWebview,
            clientCapabilities: clientCapabilities(),
            authStatus: authStatus,
            userProductSubscription: await currentUserProductSubscription(),
            workspaceFolderUris,
            isDotComUser: isDotCom(authStatus),
            siteHasCodyEnabled,
            currentUserCodySubscription,
        })
        logDebug('ChatController', 'updateViewConfig', {
            verbose: configForWebview,
        })
    }

    private async sendClientConfig(clientConfig: CodyClientConfig) {
        await this.postMessage({
            type: 'clientConfig',
            clientConfig,
        })
        logDebug('ChatController', 'updateClientConfig', {
            verbose: clientConfig,
        })
    }

    private initDoer = new InitDoer<boolean | undefined>()
    private async handleInitialized(): Promise<void> {
        // HACK: this call is necessary to get the webview to set the chatID state,
        // which is necessary on deserialization. It should be invoked before the
        // other initializers run (otherwise, it might interfere with other view
        // state)
        await this.webviewPanelOrView?.webview.postMessage({
            type: 'transcript',
            messages: [],
            isMessageInProgress: false,
            chatID: this.chatBuilder.sessionID,
        })

        void this.saveSession()
        this.initDoer.signalInitialized()
    }

    async regenerateCodeBlock(params: RegenerateRequestParams): Promise<PromptString> {
        const regenerator = new CodeBlockRegenerator(this.chatClient)
        return await regenerator.regenerate(params)
    }

    /**
     * Handles user input text for both new and edit submissions
     */
    public async handleUserMessage({
        requestID,
        inputText,
        mentions,
        editorState,
        signal,
        source,
        command,
        manuallySelectedIntent,
        traceparent,
    }: {
        requestID: string
        inputText: PromptString
        mentions: ContextItem[]
        editorState: SerializedPromptEditorState | null
        signal: AbortSignal
        source?: EventSource
        command?: DefaultChatCommands
        manuallySelectedIntent?: ChatMessage['intent'] | undefined | null
        traceparent?: string | undefined | null
        model?: string | undefined
    }): Promise<void> {
        return context.with(extractContextFromTraceparent(traceparent), () => {
            return tracer.startActiveSpan('chat.handleUserMessage', async (span): Promise<void> => {
                span.setAttribute('sampled', true)
                span.setAttribute('continued', true)
                outputChannelLogger.logDebug(
                    'ChatController',
                    'handleUserMessageSubmission',
                    `traceId: ${span.spanContext().traceId}`
                )
                // TODO: Pass the model name from webview on submit instead of fetching it here
                const model = await wrapInActiveSpan('chat.resolveModel', () =>
                    firstResultFromOperation(ChatBuilder.resolvedModelForChat(this.chatBuilder))
                )

                this.chatBuilder.setSelectedModel(model)

                this.chatBuilder.addHumanMessage({
                    text: inputText,
                    editorState,
                    intent: manuallySelectedIntent,
                    agent: DeepCodyHandler.isAgenticChatEnabled() ? DeepCodyAgent.id : undefined,
                })

                this.setCustomChatTitle(requestID, inputText, signal)
                this.postViewTranscript({ speaker: 'assistant' })

                signal.throwIfAborted()

                return this.sendChat(
                    {
                        requestID,
                        inputText,
                        mentions,
                        editorState,
                        signal,
                        source,
                        command,
                        manuallySelectedIntent,
                        model,
                    },
                    span
                )
            })
        })
    }

    private async sendChat(
        {
            requestID,
            inputText,
            mentions,
            editorState,
            signal,
            source,
            command,
            manuallySelectedIntent,
            model,
        }: Parameters<typeof this.handleUserMessage>[0],
        span: Span
    ): Promise<void> {
        if (!model) {
            throw new Error('No model selected, and no default chat model is available')
        }

        span.addEvent('ChatController.sendChat')
        signal.throwIfAborted()

        const recorder = await OmniboxTelemetry.create({
            requestID,
            chatModel: model,
            source,
            command,
            sessionID: this.chatBuilder.sessionID,
            traceId: span.spanContext().traceId,
            promptText: inputText,
        })
        recorder.recordChatQuestionSubmitted(mentions)

        signal.throwIfAborted()

        this.postEmptyMessageInProgress(model)

        const agent = getAgent(model, manuallySelectedIntent, {
            contextRetriever: this.contextRetriever,
            editor: this.editor,
            chatClient: this.chatClient,
        })

        this.setFrequentlyUsedContextItemsToStorage(mentions)

        recorder.setIntentInfo({
            userSpecifiedIntent: manuallySelectedIntent ?? 'chat',
        })

        this.postEmptyMessageInProgress(model)
        let messageInProgress: ChatMessage = { speaker: 'assistant', model }
        try {
            await agent.handle(
                {
                    requestID,
                    inputText,
                    mentions,
                    editorState,
                    signal,
                    chatBuilder: this.chatBuilder,
                    span,
                    recorder,
                    model,
                },
                {
                    postError: (error: Error, type?: MessageErrorType): void => {
                        this.postError(error, type)
                    },
                    postMessageInProgress: (message: ChatMessage): void => {
                        messageInProgress = message
                        this.postViewTranscript(message)
                    },
                    postStatuses: (steps: ProcessingStep[]): void => {
                        this.chatBuilder.setLastMessageProcesses(steps)
                        this.postViewTranscript(messageInProgress)
                    },
                    experimentalPostMessageInProgress: (subMessages: SubMessage[]): void => {
                        messageInProgress.subMessages = subMessages
                        this.postViewTranscript(messageInProgress)
                    },
                    postRequest: (step: ProcessingStep): Promise<boolean> => {
                        // Generate a unique ID for this confirmation request
                        const confirmationId = step.id

                        // Send the confirmation request to the webview
                        this.postMessage({
                            type: 'action/confirmationRequest',
                            id: confirmationId,
                            step,
                        })

                        // Wait for the webview to respond with the confirmation
                        const confirmation = new Promise<boolean>(resolve => {
                            const disposable = this._webviewPanelOrView?.webview.onDidReceiveMessage(
                                (message: WebviewMessage) => {
                                    if (
                                        message.command === 'action/confirmation' &&
                                        message.id === confirmationId
                                    ) {
                                        disposable?.dispose()
                                        resolve(message.response)
                                    }
                                }
                            )
                        })

                        // Now that we have the confirmation, proceed based on the user's choice

                        this.postViewTranscript({
                            speaker: 'assistant',
                            processes: [step],
                            model,
                        })
                        return confirmation
                    },
                    postDone: async (): Promise<void> => {
                        // Mark the end of the span for chat.handleUserMessage here, as we do not await
                        // the entire stream of chat messages being sent to the webview.
                        // The span is concluded when the stream is complete.
                        span.end()
                        if (this.chatBuilder?.isEmpty()) {
                            this.postViewTranscript()
                            return
                        }
                        // HACK(beyang): This conditional preserves the behavior from when
                        // all the response generation logic was handled in this method.
                        // In future work, we should remove this special-casing and unify
                        // how new messages are posted to the transcript.

                        if (manuallySelectedIntent === 'agentic') {
                            this.saveSession()
                        } else if (
                            messageInProgress &&
                            (['search', 'insert', 'edit'].includes(messageInProgress?.intent ?? '') ||
                                messageInProgress?.search ||
                                messageInProgress?.error)
                        ) {
                            this.chatBuilder.addBotMessage(messageInProgress, model)
                        } else if (
                            messageInProgress.subMessages &&
                            messageInProgress.subMessages.length > 0
                        ) {
                            this.chatBuilder.addBotMessage(messageInProgress, model)
                        } else if (messageInProgress?.text) {
                            this.addBotMessage(
                                requestID,
                                messageInProgress.text,
                                messageInProgress.didYouMeanQuery,
                                model
                            )
                        }
                        this.postViewTranscript()
                    },
                }
            )
        } catch (error) {
            // This ensures that the span for chat.handleUserMessage is ended even if the operation fails
            span.end()
            if (isAbortErrorOrSocketHangUp(error as Error)) {
                this.postViewTranscript()
                return
            }
            if (isRateLimitError(error) || isContextWindowLimitError(error)) {
                this.postError(error, 'transcript')
            } else {
                this.postError(
                    isError(error) ? error : new Error(`Error generating assistant response: ${error}`)
                )
            }
            recordErrorToSpan(span, error as Error)
        }
    }

    private async setFrequentlyUsedContextItemsToStorage(mentions: ContextItem[]) {
        const authStatus = currentAuthStatus()
        const activeEditor = getEditor().active

        const repoName = activeEditor?.document.uri
            ? (
                  await firstResultFromOperation(
                      repoNameResolver.getRepoNamesContainingUri(activeEditor.document.uri)
                  )
              ).at(0)
            : null

        if (authStatus.authenticated) {
            saveFrequentlyUsedContextItems({
                items: mentions
                    .filter(item => item.source === ContextItemSource.User)
                    .map(item => serializeContextItem(item)),
                authStatus,
                codebases: repoName ? [repoName] : [],
            })
        }
    }
    private async getFrequentlyUsedContextItemsFromStorage() {
        const authStatus = currentAuthStatus()
        const activeEditor = getEditor().active

        const repoName = activeEditor?.document.uri
            ? (
                  await firstResultFromOperation(
                      repoNameResolver.getRepoNamesContainingUri(activeEditor.document.uri)
                  )
              ).at(0)
            : null

        if (authStatus.authenticated) {
            return getFrequentlyUsedContextItems({
                authStatus,
                codebases: repoName ? [repoName] : [],
            })
        }

        return []
    }

    private async openRemoteFile(uri: vscode.Uri, tryLocal?: boolean) {
        if (tryLocal) {
            try {
                await this.openSourcegraphUriAsLocalFile(uri)
                return
            } catch {
                // Ignore error, just continue to opening the remote file
            }
        }

        const sourcegraphSchemaURI = uri.with({
            query: '',
            scheme: 'codysourcegraph',
        })

        // Supported line params examples: L42 (single line) or L42-45 (line range)
        const lineParam = this.extractLineParamFromURI(uri)
        const range = this.lineParamToRange(lineParam)

        vscode.workspace.openTextDocument(sourcegraphSchemaURI).then(async doc => {
            const textEditor = await vscode.window.showTextDocument(doc)

            textEditor.revealRange(range)
        })
    }

    /**
     * Attempts to open a Sourcegraph file URL as a local file in VS Code.
     * Fails if the URI is not a valid Sourcegraph URL for a file or if the
     * file does not belong to the current workspace.
     */
    private async openSourcegraphUriAsLocalFile(uri: vscode.Uri): Promise<void> {
        const match = uri.path.match(
            /^\/*(?<repoName>[^@]*)(?<revision>@.*)?\/-\/blob\/(?<filePath>.*)$/
        )
        if (!match || !match.groups) {
            throw new Error('failed to extract repo name and file path')
        }
        const { repoName, filePath } = match.groups

        const workspaceFolder = await workspaceFolderForRepo(repoName)
        if (!workspaceFolder) {
            throw new Error('could not find workspace for repo')
        }

        const lineParam = this.extractLineParamFromURI(uri)
        const selectionStart = this.lineParamToRange(lineParam).start
        // Opening the file with an active selection is awkward, so use a zero-length
        // selection to focus the target line without highlighting anything
        const selection = new vscode.Range(selectionStart, selectionStart)

        const fileUri = workspaceFolder.uri.with({
            path: `${workspaceFolder.uri.path}/${filePath}`,
        })
        const document = await vscode.workspace.openTextDocument(fileUri)
        await vscode.window.showTextDocument(document, {
            selection,
            preview: true,
        })
    }

    private extractLineParamFromURI(uri: vscode.Uri): string | undefined {
        return uri.query.split('&').find(key => key.match(/^L\d+(?:-\d+)?$/))
    }

    private lineParamToRange(lineParam?: string | null): vscode.Range {
        const lines = (lineParam ?? '0')
            .replace('L', '')
            .split('-')
            .map(num => Number.parseInt(num))

        // adding 20 lines to the end of the range to allow the start line to be visible in a more center position on the screen.
        return new vscode.Range(lines.at(0) || 0, 0, lines.at(1) || (lines.at(0) || 0) + 20, 0)
    }

    private submitOrEditOperation: AbortController | undefined
    public startNewSubmitOrEditOperation(): AbortSignal {
        this.submitOrEditOperation?.abort()
        this.submitOrEditOperation = new AbortController()
        return this.submitOrEditOperation.signal
    }

    private cancelSubmitOrEditOperation(): void {
        this.submitOrEditOperation?.abort()
        this.submitOrEditOperation = undefined
    }

    /**
     * Handles editing a human chat message in current chat session.
     *
     * Removes any existing messages from the provided index,
     * before submitting the replacement text as a new question.
     * When no index is provided, default to the last human message.
     *
     * @internal Public for testing only.
     */
    public async handleEdit({
        requestID,
        text,
        index,
        contextFiles,
        editorState,
        manuallySelectedIntent,
    }: {
        requestID: string
        text: PromptString
        index: number | undefined
        contextFiles: ContextItem[]
        editorState: SerializedPromptEditorState | null
        manuallySelectedIntent?: ChatMessage['intent']
    }): Promise<void> {
        const abortSignal = this.startNewSubmitOrEditOperation()

        telemetryRecorder.recordEvent('cody.editChatButton', 'clicked', {
            billingMetadata: {
                product: 'cody',
                category: 'billable',
            },
        })

        try {
            const humanMessage = index ?? this.chatBuilder.getLastSpeakerMessageIndex('human')
            if (humanMessage === undefined) {
                return
            }
            this.chatBuilder.removeMessagesFromIndex(humanMessage, 'human')
            return await this.handleUserMessage({
                requestID,
                inputText: text,
                mentions: contextFiles,
                editorState,
                signal: abortSignal,
                source: 'chat',
                manuallySelectedIntent,
            })
        } catch (error) {
            if (isAbortErrorOrSocketHangUp(error)) {
                return
            }
            this.postError(new Error('Failed to edit prompt'), 'transcript')
        }
    }

    /**
     * Regenerates a single code block in the transcript.
     */
    async handleRegenerateCodeBlock({
        requestID,
        code,
        language,
        index,
    }: {
        requestID: string
        code: PromptString
        language: PromptString | undefined
        index: number
    }): Promise<void> {
        const abort = this.startNewSubmitOrEditOperation()

        telemetryRecorder.recordEvent('cody.regenerateCodeBlock', 'clicked', {
            billingMetadata: {
                product: 'cody',
                category: 'billable',
            },
        })

        // TODO: Add trace spans around this operation

        try {
            const model: ChatModel | undefined = await wrapInActiveSpan('chat.resolveModel', () =>
                firstResultFromOperation(ChatBuilder.resolvedModelForChat(this.chatBuilder), abort)
            )
            if (!model) {
                throw new Error('no chat model selected')
            }
            this.postMessage({
                type: 'clientAction',
                regenerateStatus: { id: requestID, status: 'regenerating' },
            })
            const newCode = await this.regenerateCodeBlock({
                abort,
                code,
                language,
                model,
                requestID,
            })
            // Paste up the chat transcript replacing `code` with `newCode`
            if (this.chatBuilder.replaceInMessage(index, code, newCode)) {
                // Post the updated transcript to the webview
                this.postViewTranscript()
                // Save the newly generated code to the transcript.
                await this.saveSession()
            }
            this.postMessage({
                type: 'clientAction',
                regenerateStatus: { id: requestID, status: 'done' },
            })
        } catch (error) {
            this.postMessage({
                type: 'clientAction',
                regenerateStatus: {
                    id: requestID,
                    status: 'error',
                    error: `${error}`,
                },
            })
            if (isAbortErrorOrSocketHangUp(error)) {
                return
            }
            this.postError(new Error(`Failed to regenerate code: ${error}`), 'system')
        }
    }

    private handleAbort(): void {
        this.cancelSubmitOrEditOperation()
        // Notify the webview there is no message in progress.
        this.postViewTranscript()
        telemetryRecorder.recordEvent('cody.sidebar.abortButton', 'clicked', {
            billingMetadata: {
                category: 'billable',
                product: 'cody',
            },
        })
    }

    public async addContextItemsToLastHumanInput(
        contextItems: ContextItem[]
    ): Promise<boolean | undefined> {
        return this.postMessage({
            type: 'clientAction',
            addContextItemsToLastHumanInput: contextItems,
        })
    }

    public async handleGetUserEditorContext(uri?: URI): Promise<void> {
        // Get selection from the active editor
        const selection = getEditor()?.active?.selection

        // Determine context based on URI presence
        const contextItem = uri
            ? await getContextFileFromUri(uri, selection)
            : await getContextFileFromCursor()

        const { input, context } = await firstResultFromOperation(
            ChatBuilder.contextWindowForChat(this.chatBuilder)
        )
        const userContextSize = context?.user ?? input

        void this.postMessage({
            type: 'clientAction',
            addContextItemsToLastHumanInput: contextItem
                ? [
                      {
                          ...contextItem,
                          type: 'file',
                          // Remove content to avoid sending large data to the webview
                          content: undefined,
                          isTooLarge: contextItem.size ? contextItem.size > userContextSize : undefined,
                          source: ContextItemSource.Selection,
                          range: contextItem.range,
                      } satisfies ContextItem,
                  ]
                : [],
        })

        // Reveal the webview panel if it is hidden
        if (this._webviewPanelOrView) {
            revealWebviewViewOrPanel(this._webviewPanelOrView)
        }
    }

    public async handleResubmitLastUserInput(): Promise<void> {
        const lastHumanMessage = this.chatBuilder.getLastHumanMessage()
        const getLastHumanMessageText = lastHumanMessage?.text?.toString()
        if (getLastHumanMessageText) {
            await this.clearAndRestartSession()
            void this.postMessage({
                type: 'clientAction',
                appendTextToLastPromptEditor: getLastHumanMessageText,
            })
        }
    }

    public async handleSmartApplyResult(result: SmartApplyResult): Promise<void> {
        void this.postMessage({
            type: 'clientAction',
            smartApplyResult: result,
        })
    }

    public fireClientAction(): void {}

    private async handleAttributionSearch(snippet: string): Promise<void> {
        try {
            const attribution = await this.guardrails.searchAttribution(snippet)
            if (isError(attribution)) {
                await this.postMessage({
                    type: 'attribution',
                    snippet,
                    error: attribution.message,
                })
                return
            }
            await this.postMessage({
                type: 'attribution',
                snippet,
                attribution: {
                    repositoryNames: attribution.repositories.map(r => r.name),
                    limitHit: attribution.limitHit,
                },
            })
        } catch (error) {
            await this.postMessage({
                type: 'attribution',
                snippet,
                error: `${error}`,
            })
        }
    }

    // #endregion
    // =======================================================================
    // #region view updaters
    // =======================================================================

    private postEmptyMessageInProgress(model: ChatModel): void {
        this.postViewTranscript({ speaker: 'assistant', model })
    }

    private postViewTranscript(messageInProgress?: ChatMessage): void {
        const messages: ChatMessage[] = [...this.chatBuilder.getMessages()]
        if (messageInProgress) {
            messages.push(messageInProgress)
        }

        const lastTokenUsage = messages
            .slice()
            .reverse()
            .find(msg => msg.tokenUsage)?.tokenUsage

        if (lastTokenUsage !== undefined) {
            this.lastKnownTokenUsage = lastTokenUsage
        }

        // We never await on postMessage, because it can sometimes hang indefinitely:
        // https://github.com/microsoft/vscode/issues/159431
        void this.postMessage({
            type: 'transcript',
            messages: messages.map(prepareChatMessage).map(serializeChatMessage),
            isMessageInProgress: !!messageInProgress,
            chatID: this.chatBuilder.sessionID,
            tokenUsage: this.lastKnownTokenUsage,
        })

        this.syncPanelTitle()
    }

    private syncPanelTitle() {
        // Update webview panel title if we're in an editor panel
        if (this._webviewPanelOrView && 'reveal' in this._webviewPanelOrView) {
            this._webviewPanelOrView.title = this.chatBuilder.getChatTitle()
        }
    }

    /**
     * Sets the custom chat title based on the first message in the interaction.
     */
    private async setCustomChatTitle(
        requestID: string,
        inputText: PromptString,
        signal: AbortSignal
    ): Promise<void> {
        return tracer.startActiveSpan('chat.setCustomChatTitle', async (span): Promise<void> => {
            // NOTE: Only generates a custom title if the input text is long enough.
            // We are asking the LLM to generate a title with about 10 words, so 10 words * 2 chars/word = 20 chars
            // would be a reasonable threshold to start generating a custom title. This is a heuristic and
            // can be adjusted as needed.
            if (inputText.length < 20) {
                return
            }
            // Get the currently available models with speed tag.
            const speeds = modelsService.getModelsByTag(ModelTag.Speed)
            // Use the latest Gemini flash model or the first speedy model as the default.
            const model = (speeds.find(m => m.id.includes('flash-lite')) || speeds?.[0])?.id
            const messages = this.chatBuilder.getMessages()
            // Returns early if this is not the first message or if this is a testing session.
            if (messages.length > 1 || !model || isCodyTesting) {
                return
            }
            const prompt = ps`${getDefaultSystemPrompt()} Your task is to generate a concise title (in about 10 words without quotation) for <codyUserInput>${inputText}</codyUserInput>.
        RULE: Your response should only contain the concise title and nothing else.`
            let title = ''
            try {
                const stream = await this.chatClient.chat(
                    [{ speaker: 'human', text: prompt }],
                    { model, maxTokensToSample: 100 },
                    signal,
                    requestID
                )
                for await (const message of stream) {
                    if (message.type === 'change') {
                        title = message.text
                    } else if (message.type === 'complete') {
                        if (title) {
                            this.chatBuilder.setChatTitle(title)
                        }
                        break
                    }
                }
            } catch (error) {
                logDebug('ChatController', 'setCustomChatTitle', { verbose: error })
            }
            telemetryRecorder.recordEvent('cody.chat.customTitle', 'generated', {
                privateMetadata: {
                    requestID,
                    model: model,
                    traceId: span.spanContext().traceId,
                },
                metadata: {
                    titleLength: title.length,
                    inputLength: inputText.length,
                },
            })
        })
    }

    /**
     * Display error message in webview as part of the chat transcript, or as a system banner alongside the chat.
     */
    private postError(error: Error, type?: MessageErrorType): void {
        if (isRateLimitError(error)) {
            handleRateLimitError(error as RateLimitError)
        }

        logDebug('ChatController: postError', error.message)
        // Add error to transcript
        if (type === 'transcript') {
            this.chatBuilder.addErrorAsBotMessage(error, ChatBuilder.NO_MODEL)
            this.postViewTranscript()
            return
        }

        void this.postMessage({ type: 'errors', errors: error.message })
        captureException(error)
    }

    /**
     * Low-level utility to post a message to the webview, pending initialization.
     *
     * cody-invariant: this.webview.postMessage should never be invoked directly
     * except within this method.
     */
    private postMessage(message: ExtensionMessage): Thenable<boolean | undefined> {
        return this.initDoer.do(() =>
            this.webviewPanelOrView?.webview.postMessage(forceHydration(message))
        )
    }

    // #endregion
    // =======================================================================
    // #region chat request lifecycle methods
    // =======================================================================

    /**
     * Finalizes adding a bot message to the chat model and triggers an update to the view.
     */
    private async addBotMessage(
        requestID: string,
        rawResponse: PromptString,
        didYouMeanQuery: string | undefined | null,
        model: ChatModel
    ): Promise<void> {
        const messageText = reformatBotMessageForChat(rawResponse)
        this.chatBuilder.addBotMessage({ text: messageText, didYouMeanQuery }, model)
        void this.saveSession()
        this.postViewTranscript()

        const authStatus = currentAuthStatus()

        // Count code generated from response
        const generatedCode = countGeneratedCode(messageText.toString())
        const responseEventAction = generatedCode.charCount > 0 ? 'hasCode' : 'noCode'
        telemetryRecorder.recordEvent('cody.chatResponse', responseEventAction, {
            version: 2, // increment for major changes to this event
            interactionID: requestID,
            metadata: {
                ...generatedCode,
                // Flag indicating this is a transcript event to go through ML data pipeline. Only for dotcom users
                // See https://github.com/sourcegraph/sourcegraph/pull/59524
                recordsPrivateMetadataTranscript: isDotCom(authStatus) ? 1 : 0,
            },
            privateMetadata: {
                // 🚨 SECURITY: chat transcripts are to be included only for DotCom users AND for V2 telemetry
                // V2 telemetry exports privateMetadata only for DotCom users
                // the condition below is an aditional safegaurd measure
                responseText:
                    isDotCom(authStatus) &&
                    (await truncatePromptString(messageText, CHAT_OUTPUT_TOKEN_BUDGET)),
                chatModel: model,
            },
            billingMetadata: {
                product: 'cody',
                category: 'billable',
            },
        })
    }

    // #endregion
    // =======================================================================
    // #region session management
    // =======================================================================

    // A unique identifier for this ChatController instance used to identify
    // it when a handle to this specific panel provider is needed.
    public get sessionID(): string {
        return this.chatBuilder.sessionID
    }

    // Attempts to restore the chat to the given sessionID, if it exists in
    // history. If it does, then saves the current session and cancels the
    // current in-progress completion. If the chat does not exist, then this
    // is a no-op.
    public restoreSession(sessionID: string): void {
        const authStatus = currentAuthStatus()
        if (!authStatus.authenticated) {
            return
        }
        const oldTranscript = chatHistory.getChat(authStatus, sessionID)
        if (!oldTranscript) {
            return
        }
        this.cancelSubmitOrEditOperation()
        const newModel = newChatModelFromSerializedChatTranscript(oldTranscript, undefined)
        this.chatBuilder = newModel
        this.lastKnownTokenUsage = undefined

        this.postViewTranscript()
    }

    /**
     * This method will serialize the chat state synchronously and then save the serialized state to
     * local storage. Usually, it can safely be called without `await`ing.
     * This method should only be awaited if the caller wants to wait for the saved data to be synced
     * to local storage before proceeding.
     */
    private async saveSession(): Promise<void> {
        try {
            const authStatus = currentAuthStatus()
            // Only try to save if authenticated because otherwise we wouldn't be showing a chat.
            const chat = this.chatBuilder.toSerializedChatTranscript()
            if (chat && authStatus.authenticated) {
                const shouldShowStorageWarning = await chatHistory.saveChat(authStatus, chat)
                if (shouldShowStorageWarning) {
                    this.postError(new Error('STORAGE_WARNING'), 'storage')
                }
            }
        } catch (error) {
            logDebug('ChatController', 'Failed')
        }
    }

    private async duplicateSession(sessionID: string): Promise<void> {
        this.cancelSubmitOrEditOperation()
        const transcript = chatHistory.getChat(currentAuthStatusAuthed(), sessionID)
        if (!transcript) {
            return
        }
        // Assign a new session ID to the duplicated session
        this.chatBuilder = newChatModelFromSerializedChatTranscript(
            transcript,
            this.chatBuilder.selectedModel,
            new Date(Date.now()).toUTCString()
        )
        this.postViewTranscript()
        // Move the new session to the editor
        await vscode.commands.executeCommand('cody.chat.moveToEditor')
        // Restore the old session in the current window
        this.restoreSession(sessionID)

        telemetryRecorder.recordEvent('cody.duplicateSession', 'clicked', {
            billingMetadata: { product: 'cody', category: 'billable' },
        })
    }

    public clearAndRestartSession(chatMessages?: ChatMessage[]): void {
        // Only clear the session if session is not empty.
        if (!this.chatBuilder?.isEmpty()) {
            this.saveSession()
            this.chatBuilder = new ChatBuilder(this.chatBuilder.selectedModel, undefined, chatMessages)
            this.lastKnownTokenUsage = undefined
            this.postViewTranscript()
        }
        this.cancelSubmitOrEditOperation()
    }

    // #endregion
    // =======================================================================
    // #region webview container management
    // =======================================================================

    private extensionUri: vscode.Uri
    private _webviewPanelOrView?: vscode.WebviewView | vscode.WebviewPanel
    public get webviewPanelOrView(): vscode.WebviewView | vscode.WebviewPanel | undefined {
        return this._webviewPanelOrView
    }

    /**
     * Creates the webview view or panel for the Cody chat interface if it doesn't already exist.
     */
    public async createWebviewViewOrPanel(
        activePanelViewColumn?: vscode.ViewColumn,
        lastQuestion?: string
    ): Promise<vscode.WebviewView | vscode.WebviewPanel> {
        // Checks if the webview view or panel already exists and is visible.
        // If so, returns early to avoid creating a duplicate.
        if (this.webviewPanelOrView) {
            return this.webviewPanelOrView
        }

        const viewType = CodyChatEditorViewType
        const panelTitle =
            chatHistory.getChat(currentAuthStatusAuthed(), this.chatBuilder.sessionID)?.chatTitle ||
            getChatPanelTitle(lastQuestion)
        const viewColumn = activePanelViewColumn || vscode.ViewColumn.Beside
        const webviewPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews')
        const panel = vscode.window.createWebviewPanel(
            viewType,
            panelTitle,
            { viewColumn, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                enableFindWidget: true,
                localResourceRoots: [webviewPath],
                enableCommandUris: true,
            }
        )

        return this.registerWebviewPanel(panel)
    }

    /**
     * Revives the chat panel when the extension is reactivated.
     */
    public async revive(webviewPanel: vscode.WebviewPanel): Promise<void> {
        logDebug('ChatController:revive', 'registering webview panel')
        await this.registerWebviewPanel(webviewPanel)
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext<unknown>,
        _token: vscode.CancellationToken
    ): Promise<void> {
        await this.resolveWebviewViewOrPanel(webviewView)
    }

    /**
     * Registers the given webview panel by setting up its options, icon, and handlers.
     * Also stores the panel reference and disposes it when closed.
     */
    private async registerWebviewPanel(panel: vscode.WebviewPanel): Promise<vscode.WebviewPanel> {
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'active-chat-icon.svg')
        return this.resolveWebviewViewOrPanel(panel)
    }

    private async resolveWebviewViewOrPanel<T extends vscode.WebviewView | vscode.WebviewPanel>(
        viewOrPanel: T
    ): Promise<T> {
        this._webviewPanelOrView = viewOrPanel
        this.syncPanelTitle()

        const webviewPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews')
        viewOrPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [webviewPath],
            enableCommandUris: true,
        }

        await addWebviewViewHTML(this.extensionClient, this.extensionUri, viewOrPanel)

        // Dispose panel when the panel is closed
        viewOrPanel.onDidDispose(() => {
            this.cancelSubmitOrEditOperation()
            this._webviewPanelOrView = undefined
        })

        this.disposables.push(
            viewOrPanel.webview.onDidReceiveMessage(message =>
                this.onDidReceiveMessage(
                    hydrateAfterPostMessage(message, uri => vscode.Uri.from(uri as any))
                )
            )
        )

        // Listen for API calls from the webview.
        const defaultContext = getEmptyOrDefaultContextObservable({
            chatBuilder: this.chatBuilder.changes,
        }).pipe(shareReplay())

        this.disposables.push(
            addMessageListenersForExtensionAPI(
                createMessageAPIForExtension({
                    postMessage: this.postMessage.bind(this),
                    postError: this.postError.bind(this),
                    onMessage: callback => {
                        const disposable = viewOrPanel.webview.onDidReceiveMessage(callback)
                        return () => disposable.dispose()
                    },
                }),
                {
                    mentionMenuData: query => {
                        return featureFlagProvider
                            .evaluatedFeatureFlag(FeatureFlag.CodyExperimentalPromptEditor)
                            .pipe(
                                switchMap((experimentalPromptEditor: boolean) =>
                                    getMentionMenuData({
                                        disableProviders:
                                            this.extensionClient.capabilities
                                                ?.disabledMentionsProviders || [],
                                        query: query,
                                        chatBuilder: this.chatBuilder,
                                        experimentalPromptEditor,
                                    })
                                )
                            )
                    },
                    frequentlyUsedContextItems: () => {
                        return promiseFactoryToObservable(this.getFrequentlyUsedContextItemsFromStorage)
                    },
                    clientActionBroadcast: () => this.clientBroadcast,
                    evaluatedFeatureFlag: flag => featureFlagProvider.evaluatedFeatureFlag(flag),
                    hydratePromptMessage: (promptText, initialContext) =>
                        promiseFactoryToObservable(() =>
                            hydratePromptText(promptText, initialContext ?? [])
                        ),
                    promptsMigrationStatus: () => getPromptsMigrationInfo(),
                    startPromptsMigration: () => promiseFactoryToObservable(startPromptsMigration),
                    getCurrentUserId: () =>
                        promiseFactoryToObservable(signal => getCurrentUserId(signal)),
                    prompts: input =>
                        promiseFactoryToObservable(signal =>
                            mergedPromptsAndLegacyCommands(input, signal)
                        ),
                    repos: input =>
                        promiseFactoryToObservable(async () => {
                            const response = await graphqlClient.getRepoList(input)

                            return isError(response) ? [] : response.repositories.nodes
                        }),
                    promptTags: () => promiseFactoryToObservable(signal => listPromptTags(signal)),
                    models: () =>
                        modelsService.modelsChanges.pipe(
                            map(models => (models === pendingOperation ? null : models))
                        ),
                    chatModels: () =>
                        modelsService.getModels(ModelUsage.Chat).pipe(
                            startWith([]),
                            map(models => (models === pendingOperation ? [] : models))
                        ),
                    highlights: parameters =>
                        promiseFactoryToObservable(() =>
                            graphqlClient.getHighlightedFileChunk(parameters)
                        ).pipe(
                            map(result => {
                                if (isError(result)) {
                                    return []
                                }

                                return result
                            })
                        ),
                    setChatModel: model => {
                        // Because this was a user action to change the model we will set that
                        // as a global default for chat
                        return promiseFactoryToObservable(async () => {
                            this.chatBuilder.setSelectedModel(model)
                            await modelsService.setSelectedModel(ModelUsage.Chat, model)
                        })
                    },
                    defaultContext: () => defaultContext.pipe(skipPendingOperation()),
                    resolvedConfig: () => resolvedConfig,
                    authStatus: () => authStatus,
                    transcript: () =>
                        this.chatBuilder.changes.pipe(map(chat => chat.getDehydratedMessages())),
                    userHistory: type =>
                        type === ChatHistoryType.Full
                            ? chatHistory.changes
                            : chatHistory.lightweightChanges,
                    userProductSubscription: () =>
                        userProductSubscription.pipe(
                            map(value => (value === pendingOperation ? null : value))
                        ),
                    // Existing tools endpoint - update to include MCP tools
                    mcpSettings: () => {
                        return featureFlagProvider
                            .evaluatedFeatureFlag(FeatureFlag.AgenticChatWithMCP)
                            .pipe(
                                distinctUntilChanged(),
                                startWith(null),
                                // When disabled, return null
                                switchMap(experimentalAgentMode => {
                                    if (!experimentalAgentMode) {
                                        return Observable.of(null as McpServer[] | null)
                                    }
                                    // When enabled, get servers from the manager
                                    return MCPManager.observable
                                })
                            )
                    },
                }
            )
        )

        return viewOrPanel
    }

    private async setWebviewToChat(): Promise<void> {
        const viewOrPanel = this._webviewPanelOrView ?? (await this.createWebviewViewOrPanel())
        this._webviewPanelOrView = viewOrPanel
        revealWebviewViewOrPanel(viewOrPanel)
        await this.postMessage({
            type: 'view',
            view: View.Chat,
        })
    }

    // #endregion
    // =======================================================================
    // #region other public accessors and mutators
    // =======================================================================

    // Convenience function for tests
    public getViewTranscript(): readonly ChatMessage[] {
        return this.chatBuilder.getMessages().map(prepareChatMessage)
    }

    public isEmpty(): boolean {
        return this.chatBuilder.isEmpty()
    }

    public isVisible(): boolean {
        return this.webviewPanelOrView?.visible ?? false
    }
}

function newChatModelFromSerializedChatTranscript(
    json: SerializedChatTranscript,
    modelID: string | undefined,
    newSessionID?: string
): ChatBuilder {
    return new ChatBuilder(
        migrateAndNotifyForOutdatedModels(modelID ?? null) ?? undefined,
        newSessionID ?? json.id,
        json.interactions.flatMap((interaction: SerializedChatInteraction): ChatMessage[] =>
            [
                PromptString.unsafe_deserializeChatMessage(interaction.humanMessage),
                interaction.assistantMessage
                    ? PromptString.unsafe_deserializeChatMessage(interaction.assistantMessage)
                    : null,
            ].filter(isDefined)
        ),
        json.chatTitle
    )
}

export function disposeWebviewViewOrPanel(viewOrPanel: vscode.WebviewView | vscode.WebviewPanel): void {
    if ('dispose' in viewOrPanel) {
        viewOrPanel.dispose()
    }
}

export function webviewViewOrPanelViewColumn(
    viewOrPanel: vscode.WebviewView | vscode.WebviewPanel
): vscode.ViewColumn | undefined {
    if ('viewColumn' in viewOrPanel) {
        return viewOrPanel.viewColumn
    }
    // Our view is in the sidebar, return undefined
    return undefined
}

export function webviewViewOrPanelOnDidChangeViewState(
    viewOrPanel: vscode.WebviewView | vscode.WebviewPanel
): vscode.Event<vscode.WebviewPanelOnDidChangeViewStateEvent> {
    if ('onDidChangeViewState' in viewOrPanel) {
        return viewOrPanel.onDidChangeViewState
    }
    // Return a no-op (this means the provider is for the sidebar)
    return () => {
        return {
            dispose: () => {},
        }
    }
}

export function revealWebviewViewOrPanel(viewOrPanel: vscode.WebviewView | vscode.WebviewPanel): void {
    if ('reveal' in viewOrPanel) {
        viewOrPanel.reveal()
    }
}

/**
 * Set HTML for webview (panel) & webview view (sidebar)
 */
async function addWebviewViewHTML(
    extensionClient: Pick<ExtensionClient, 'capabilities'>,
    extensionUri: vscode.Uri,
    view: vscode.WebviewView | vscode.WebviewPanel
): Promise<void> {
    if (extensionClient.capabilities?.webview === 'agentic') {
        return
    }
    const config = extensionClient.capabilities?.webviewNativeConfig
    const webviewPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webviews')
    const root = vscode.Uri.joinPath(webviewPath, 'index.html')
    const bytes = await vscode.workspace.fs.readFile(root)
    const html = new TextDecoder('utf-8').decode(bytes)

    view.webview.html = manipulateWebviewHTML(html, {
        cspSource: view.webview.cspSource,
        resources: config?.skipResourceRelativization
            ? undefined
            : view.webview.asWebviewUri(webviewPath),
        injectScript: config?.injectScript ?? undefined,
        injectStyle: config?.injectStyle ?? undefined,
    })
}

interface TransformHTMLOptions {
    cspSource: string
    resources?: vscode.Uri
    injectScript?: string
    injectStyle?: string
}

// Exported for testing purposes
export function manipulateWebviewHTML(html: string, options: TransformHTMLOptions): string {
    if (options.resources) {
        html = html.replaceAll('./', `${options.resources}/`)
    }

    // If a script or style is injected, replace the placeholder with the script or style
    // and drop the content-security-policy meta tag which prevents inline scripts and styles
    if (options.injectScript || options.injectStyle) {
        html = html
            .replace(/<!-- START CSP -->.*<!-- END CSP -->/s, '')
            .replaceAll('/*injectedScript*/', options.injectScript ?? '')
            .replaceAll('/*injectedStyle*/', options.injectStyle ?? '')
    } else {
        // Update URIs for content security policy to only allow specific scripts to be run
        html = html.replaceAll("'self'", options.cspSource).replaceAll('{cspSource}', options.cspSource)
    }

    return html
}
