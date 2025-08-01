import { expect } from '@playwright/test'

import {
    chatInputMentions,
    clickEditorTab,
    createEmptyChatPanel,
    mentionMenu,
    mentionMenuItems,
    openFileInEditorTab,
    selectLineRangeInEditorTab,
    sidebarSignin,
} from './common'
import { type WorkspaceDirectory, mockEnterpriseRepoMapping, test, testWithGitRemote } from './helpers'

testWithGitRemote('initial context - enterprise repo', async ({ page, sidebar, server }) => {
    mockEnterpriseRepoMapping(server, 'codehost.example/user/myrepo')

    await sidebarSignin(page, sidebar)
    const [, lastChatInput] = await createEmptyChatPanel(page)

    // The current repository should be initially present in the chat input.
    await expect(chatInputMentions(lastChatInput)).toHaveText(['myrepo'])
})

testWithGitRemote('initial context - file', async ({ page, sidebar, server }) => {
    mockEnterpriseRepoMapping(server, 'codehost.example/user/myrepo')

    await sidebarSignin(page, sidebar)

    await openFileInEditorTab(page, 'main.c')

    const [, lastChatInput] = await createEmptyChatPanel(page)
    await expect(chatInputMentions(lastChatInput)).toHaveText(['main.c', 'myrepo'])

    // Initial context should not include current selection. Current selection should be added explicitly.
    await selectLineRangeInEditorTab(page, 2, 4)
    await expect(chatInputMentions(lastChatInput)).toHaveText(['main.c', 'main.c:2-4', 'myrepo'])

    // selecting another range modifies the 'current selection' mention
    await selectLineRangeInEditorTab(page, 1, 3)
    await expect(chatInputMentions(lastChatInput)).toHaveText(['main.c', 'main.c:1-3', 'myrepo'])

    await openFileInEditorTab(page, 'README.md')
    await expect(chatInputMentions(lastChatInput)).toHaveText(['README.md', 'myrepo'])

    await clickEditorTab(page, 'main.c')
    await expect(chatInputMentions(lastChatInput)).toHaveText(['main.c', 'myrepo'])

    // After typing into the input, it no longer updates the initial context.
    await lastChatInput.press('x')
    await clickEditorTab(page, 'README.md')
    await expect(chatInputMentions(lastChatInput)).toHaveText(['main.c', 'myrepo'])
})

// Test with multi-root workspace to verify initial context switches between workspace folders
const testWithMultiRoot = test.extend<WorkspaceDirectory>({
    // biome-ignore lint/correctness/noEmptyPattern: Playwright needs empty pattern to specify "no dependencies".
    workspaceDirectory: async ({}, use) => {
        const path = require('node:path')
        const vscodeRoot = path.resolve(__dirname, '..', '..')
        // Use the multi-root.code-workspace file to load both workspace and workspace2 folders
        const multiRootWorkspaceFile = path.join(
            vscodeRoot,
            'test',
            'fixtures',
            'multi-root.code-workspace'
        )
        await use(multiRootWorkspaceFile)
    },
})

testWithMultiRoot(
    'initial context - switches between multi-root workspace folders',
    async ({ page, sidebar, server }) => {
        // Mock enterprise repo mapping for both workspace folders
        server.onGraphQl('RepositoryIds').replyJson({
            data: {
                repositories: [
                    { name: 'github.com/sourcegraph/workspace', id: 'workspace-id' },
                    { name: 'github.com/sourcegraph/workspace2', id: 'workspace2-id' },
                ],
            },
        })

        // Mock additional endpoints needed for enterprise context (from mockEnterpriseRepoMapping)
        server.onGraphQl('Repositories').replyJson({
            data: {
                repositories: {
                    nodes: [
                        { id: 'workspace-id', name: 'github.com/sourcegraph/workspace' },
                        { id: 'workspace2-id', name: 'github.com/sourcegraph/workspace2' },
                    ],
                    pageInfo: { endCursor: 'workspace2-id' },
                },
            },
        })
        server.onGraphQl('Repository').replyJson({
            data: { repository: { id: 'workspace-id' } },
        })
        server.onGraphQl('ResolveRepoName').replyJson({
            data: { repository: { name: 'github.com/sourcegraph/workspace' } },
        })

        await sidebarSignin(page, sidebar)
        await openFileInEditorTab(page, 'buzz.ts')
        const [chatFrame, lastChatInput] = await createEmptyChatPanel(page)

        await expect(chatInputMentions(lastChatInput)).toHaveText(['buzz.ts', 'workspace'])

        // Switch to README.md from workspace2 and verify initial context changes
        await selectLineRangeInEditorTab(page, 2, 4)
        await openFileInEditorTab(page, 'README.md')

        await expect(chatInputMentions(lastChatInput)).toHaveText(['README.md', 'workspace2'])

        // Verify the file is open by checking the tab
        await expect(page.getByRole('tab', { name: /README.md/ })).toBeVisible()

        await lastChatInput.click()
        await lastChatInput.fill('@')

        // Wait for @ mention menu to appear
        await expect(mentionMenu(chatFrame)).toBeVisible()

        // Both workspace folders should be available for @ mention
        // The mention menu now includes more items, so we check that our workspaces are present
        const mentionItems = mentionMenuItems(chatFrame)
        await expect(mentionItems).toContainText(['workspace'])
        await expect(mentionItems).toContainText(['workspace2'])
    }
)
