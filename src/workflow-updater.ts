import * as core from '@actions/core';
import * as github from '@actions/github';
import * as yaml from 'yaml';
import type { ActionType } from './inputs';

type Octokit = ReturnType<typeof github.getOctokit>;

interface UpdateOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  action: ActionType;
  inputName: string;
  workflows: string[];
  choiceValue: string;
  newChoiceValue?: string;
  commitMessage: string;
  branch: string;
}

interface UpdateResult {
  updatedWorkflows: string[];
  changesMade: boolean;
}

interface WorkflowInput {
  description?: string;
  required?: boolean;
  default?: string;
  type?: string;
  options?: string[];
}

interface WorkflowDispatch {
  inputs?: Record<string, WorkflowInput>;
}

interface WorkflowContent {
  on?: {
    workflow_dispatch?: WorkflowDispatch;
  };
}

export async function updateWorkflowChoices(options: UpdateOptions): Promise<UpdateResult> {
  const { octokit, owner, repo, workflows, branch } = options;
  const updatedWorkflows: string[] = [];

  for (const workflowFile of workflows) {
    const workflowPath = `.github/workflows/${workflowFile}`;

    try {
      // Get current workflow file content
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: workflowPath,
        ref: branch,
      });

      const fileData = response.data as { content?: string; sha: string };

      if (!fileData.content) {
        core.warning(`${workflowFile} is not a file, skipping`);
        continue;
      }

      const currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
      const updatedContent = modifyWorkflowContent(currentContent, options);

      if (updatedContent === currentContent) {
        core.info(`No changes needed for ${workflowFile}`);
        continue;
      }

      // Commit the updated workflow
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: workflowPath,
        message: options.commitMessage,
        content: Buffer.from(updatedContent).toString('base64'),
        sha: fileData.sha,
        branch,
      });

      updatedWorkflows.push(workflowFile);
      core.info(`Updated ${workflowFile}`);
    } catch (error) {
      if (
        error instanceof Error &&
        'status' in error &&
        (error as { status: number }).status === 404
      ) {
        core.warning(`Workflow ${workflowFile} not found, skipping`);
      } else {
        throw error;
      }
    }
  }

  return {
    updatedWorkflows,
    changesMade: updatedWorkflows.length > 0,
  };
}

export function modifyWorkflowContent(
  content: string,
  options: Pick<UpdateOptions, 'action' | 'inputName' | 'choiceValue' | 'newChoiceValue'>
): string {
  const { action, inputName, choiceValue, newChoiceValue } = options;

  // Parse YAML while preserving formatting as much as possible
  const doc = yaml.parseDocument(content);

  // Check if the document has errors - if so, use regex fallback immediately
  if (doc.errors && doc.errors.length > 0) {
    core.warning(
      `YAML document has parsing errors, using fallback: ${doc.errors.map((e) => e.message).join(', ')}`
    );
    // We still need to determine current options and new options, so parse loosely
    return modifyWithFallback(content, options);
  }

  const workflow = doc.toJS() as WorkflowContent;

  // Navigate to the input options
  const workflowDispatch = workflow.on?.workflow_dispatch;
  if (!workflowDispatch?.inputs) {
    core.warning('No workflow_dispatch inputs found in workflow');
    return content;
  }

  const input = workflowDispatch.inputs[inputName];
  if (!input) {
    core.warning(`Input "${inputName}" not found in workflow`);
    return content;
  }

  if (input.type !== 'choice' || !Array.isArray(input.options)) {
    core.warning(`Input "${inputName}" is not a choice type or has no options`);
    return content;
  }

  // Perform the action
  let modified = false;
  const currentOptions = [...input.options];

  switch (action) {
    case 'add': {
      if (!currentOptions.includes(choiceValue)) {
        currentOptions.push(choiceValue);
        modified = true;
        core.info(`Added choice "${choiceValue}" to input "${inputName}"`);
      } else {
        core.info(`Choice "${choiceValue}" already exists in input "${inputName}"`);
      }
      break;
    }

    case 'delete': {
      const index = currentOptions.indexOf(choiceValue);
      if (index !== -1) {
        currentOptions.splice(index, 1);
        modified = true;
        core.info(`Deleted choice "${choiceValue}" from input "${inputName}"`);
      } else {
        core.info(`Choice "${choiceValue}" not found in input "${inputName}"`);
      }
      break;
    }

    case 'update': {
      const index = currentOptions.indexOf(choiceValue);
      if (index !== -1 && newChoiceValue) {
        currentOptions[index] = newChoiceValue;
        modified = true;
        core.info(`Updated choice "${choiceValue}" to "${newChoiceValue}" in input "${inputName}"`);
      } else {
        core.info(`Choice "${choiceValue}" not found in input "${inputName}"`);
      }
      break;
    }
  }

  if (!modified) {
    return content;
  }

  // Update the document while preserving structure
  // Navigate through the YAML document structure
  const onNode = doc.get('on');
  if (yaml.isMap(onNode)) {
    const dispatchNode = onNode.get('workflow_dispatch');
    if (yaml.isMap(dispatchNode)) {
      const inputsNode = dispatchNode.get('inputs');
      if (yaml.isMap(inputsNode)) {
        const targetInput = inputsNode.get(inputName);
        if (yaml.isMap(targetInput)) {
          // Create a new sequence node with the updated options
          const optionsSeq = doc.createNode(currentOptions);
          targetInput.set('options', optionsSeq);
        }
      }
    }
  }

  // Check for document errors before stringifying
  if (doc.errors && doc.errors.length > 0) {
    core.warning(`YAML document has errors: ${doc.errors.map((e) => e.message).join(', ')}`);
    // Fall back to regex-based replacement if YAML has errors
    return replaceOptionsWithRegex(content, inputName, currentOptions);
  }

  return doc.toString();
}

/**
 * Fallback function for when YAML parsing has errors.
 * Extracts current options using regex, applies the action, then uses regex replacement.
 */
export function modifyWithFallback(
  content: string,
  options: Pick<UpdateOptions, 'action' | 'inputName' | 'choiceValue' | 'newChoiceValue'>
): string {
  const { action, inputName, choiceValue, newChoiceValue } = options;

  // Extract current options for this input using regex
  const currentOptions = extractOptionsWithRegex(content, inputName);

  if (currentOptions.length === 0) {
    core.warning(`Could not find options for input "${inputName}" using fallback parser`);
    return content;
  }

  // Apply the action
  let newOptions: string[];
  let modified = false;

  switch (action) {
    case 'add': {
      if (!currentOptions.includes(choiceValue)) {
        newOptions = [...currentOptions, choiceValue];
        modified = true;
        core.info(`Added choice "${choiceValue}" to input "${inputName}"`);
      } else {
        newOptions = currentOptions;
        core.info(`Choice "${choiceValue}" already exists in input "${inputName}"`);
      }
      break;
    }
    case 'delete': {
      const index = currentOptions.indexOf(choiceValue);
      if (index !== -1) {
        newOptions = currentOptions.filter((_, i) => i !== index);
        modified = true;
        core.info(`Deleted choice "${choiceValue}" from input "${inputName}"`);
      } else {
        newOptions = currentOptions;
        core.info(`Choice "${choiceValue}" not found in input "${inputName}"`);
      }
      break;
    }
    case 'update': {
      const index = currentOptions.indexOf(choiceValue);
      if (index !== -1 && newChoiceValue) {
        newOptions = [...currentOptions];
        newOptions[index] = newChoiceValue;
        modified = true;
        core.info(`Updated choice "${choiceValue}" to "${newChoiceValue}" in input "${inputName}"`);
      } else {
        newOptions = currentOptions;
        core.info(`Choice "${choiceValue}" not found in input "${inputName}"`);
      }
      break;
    }
    default:
      newOptions = currentOptions;
  }

  if (!modified) {
    return content;
  }

  return replaceOptionsWithRegex(content, inputName, newOptions);
}

/**
 * Extract options for a given input name using regex.
 */
export function extractOptionsWithRegex(content: string, inputName: string): string[] {
  const lines = content.split('\n');
  const options: string[] = [];
  let inTargetInput = false;
  let inOptions = false;
  let inputIndent = '';
  let optionsIndent = '';

  for (const line of lines) {
    const trimmed = line.trim();
    const currentIndent = line.match(/^(\s*)/)?.[1] || '';

    // Check if we're entering the target input
    if (trimmed.startsWith(`${inputName}:`)) {
      inTargetInput = true;
      inputIndent = currentIndent;
      continue;
    }

    // If we're in the target input
    if (inTargetInput) {
      // Check if we've exited the input block
      if (trimmed && currentIndent.length <= inputIndent.length && !trimmed.startsWith('-')) {
        break;
      }

      // Check if we're entering options
      if (trimmed === 'options:') {
        inOptions = true;
        optionsIndent = currentIndent;
        continue;
      }

      // If we're in options, collect them
      if (inOptions) {
        // Check if we've exited options
        if (trimmed && !trimmed.startsWith('-') && currentIndent.length <= optionsIndent.length) {
          break;
        }

        if (trimmed.startsWith('-')) {
          const option = trimmed.replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '');
          options.push(option);
        }
      }
    }
  }

  return options;
}

/**
 * Fallback function to replace options using regex when YAML parsing has issues.
 * This preserves the original formatting better in edge cases.
 */
export function replaceOptionsWithRegex(
  content: string,
  inputName: string,
  newOptions: string[]
): string {
  // Find the input block and replace its options
  const lines = content.split('\n');
  const result: string[] = [];
  let inTargetInput = false;
  let optionsIndent = '';
  let inputIndent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if we're entering the target input
    if (trimmed.startsWith(`${inputName}:`)) {
      inTargetInput = true;
      inputIndent = line.match(/^(\s*)/)?.[1] || '';
      result.push(line);
      continue;
    }

    // If we're in the target input, look for options
    if (inTargetInput) {
      const currentIndent = line.match(/^(\s*)/)?.[1] || '';

      // Check if we've exited the input block (less or equal indentation and non-empty)
      if (trimmed && currentIndent.length <= inputIndent.length && !trimmed.startsWith('-')) {
        inTargetInput = false;
      }

      // Check if we're entering options
      if (inTargetInput && trimmed === 'options:') {
        optionsIndent = currentIndent;
        result.push(line);

        // Add new options
        const optionItemIndent = optionsIndent + '  ';
        for (const opt of newOptions) {
          result.push(`${optionItemIndent}- ${opt}`);
        }

        // Skip existing options
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const nextTrimmed = nextLine.trim();
          if (nextTrimmed.startsWith('-')) {
            i++;
          } else {
            break;
          }
        }
        continue;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}
