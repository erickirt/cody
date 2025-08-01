package com.sourcegraph.cody.edit

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.sourcegraph.cody.agent.protocol_extensions.toBoundedOffset
import com.sourcegraph.cody.agent.protocol_extensions.toOffsetRange
import com.sourcegraph.cody.agent.protocol_generated.CreateFileOperation
import com.sourcegraph.cody.agent.protocol_generated.DeleteTextEdit
import com.sourcegraph.cody.agent.protocol_generated.EditFileOperation
import com.sourcegraph.cody.agent.protocol_generated.InsertTextEdit
import com.sourcegraph.cody.agent.protocol_generated.ReplaceTextEdit
import com.sourcegraph.cody.agent.protocol_generated.TextEdit
import com.sourcegraph.cody.agent.protocol_generated.WorkspaceEditParams
import com.sourcegraph.utils.CodyEditorUtil

@Service(Service.Level.PROJECT)
class EditService(val project: Project) {
  val logger = Logger.getInstance(TextEdit::class.java)

  /**
   * Applies a list of text edits to the specified file.
   *
   * @param uri The URI of the file to apply the edits to.
   * @param edits The list of text edits to apply.
   * @return `true` if all edits were successfully applied, `false` otherwise.
   */
  fun performTextEdits(uri: String, edits: List<TextEdit>): Boolean {
    val file =
        CodyEditorUtil.findFile(uri)
            ?: run {
              logger.warn("Failed to find file for URI: $uri")
              return false
            }
    val document =
        FileDocumentManager.getInstance().getDocument(file)
            ?: run {
              logger.warn("Failed to get document for file: ${file.name}")
              return false
            }

    return WriteCommandAction.runWriteCommandAction<Boolean>(project) {
      edits.reversed().all { edit ->
        when (edit) {
          is ReplaceTextEdit -> {
            val (startOffset, endOffset) = edit.range.toOffsetRange(document) ?: return@all false
            document.replaceString(startOffset, endOffset, edit.value)
            true
          }
          is DeleteTextEdit -> {
            val (startOffset, endOffset) = edit.range.toOffsetRange(document) ?: return@all false
            document.deleteString(startOffset, endOffset)
            true
          }
          is InsertTextEdit -> {
            document.insertString(edit.position.toBoundedOffset(document), edit.value)
            true
          }
        }
      }
    }
  }

  fun performWorkspaceEdit(workspaceEditParams: WorkspaceEditParams): Boolean {
    return workspaceEditParams.operations.all { op ->
      when (op) {
        is CreateFileOperation -> {
          logger.info("Workspace edit operation created a file: ${op.uri}")
          val file =
              CodyEditorUtil.createFileOrUseExisting(
                  project,
                  uriString = op.uri,
                  content = op.textContents,
                  overwrite = op.options?.overwrite ?: false)
          file != null
        }
        is EditFileOperation -> {
          logger.info("Applying workspace edit to a file: ${op.uri}")
          performTextEdits(op.uri, op.edits)
        }
      }
    }
  }

  companion object {
    fun getInstance(project: Project): EditService {
      return project.service<EditService>()
    }
  }
}
