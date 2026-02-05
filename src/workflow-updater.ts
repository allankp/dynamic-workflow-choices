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

  return doc.toString();
}
