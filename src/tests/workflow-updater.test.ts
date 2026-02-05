import { describe, it, expect } from 'vitest';
import {
  modifyWorkflowContent,
  modifyWithFallback,
  extractOptionsWithRegex,
  replaceOptionsWithRegex,
  updateWorkflowChoices,
} from '../workflow-updater';

// Mock octokit for testing updateWorkflowChoices
function createMockOctokit(options: {
  getContentResponse?: { content?: string; sha: string } | null;
  getContentError?: Error;
  createOrUpdateResponse?: object;
  createOrUpdateError?: Error;
}): ReturnType<typeof import('@actions/github').getOctokit> {
  return {
    rest: {
      repos: {
        getContent: () => {
          if (options.getContentError) {
            return Promise.reject(options.getContentError);
          }
          return Promise.resolve({ data: options.getContentResponse });
        },
        createOrUpdateFileContents: () => {
          if (options.createOrUpdateError) {
            return Promise.reject(options.createOrUpdateError);
          }
          return Promise.resolve(options.createOrUpdateResponse || {});
        },
      },
    },
  } as ReturnType<typeof import('@actions/github').getOctokit>;
}

describe('updateWorkflowChoices', () => {
  const sampleWorkflowContent = Buffer.from(
    `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options:
          - development
          - staging
          - production
jobs:
  deploy:
    runs-on: ubuntu-latest
`
  ).toString('base64');

  it('should update a workflow successfully', async () => {
    const mockOctokit = createMockOctokit({
      getContentResponse: { content: sampleWorkflowContent, sha: 'abc123' },
      createOrUpdateResponse: {},
    });

    const result = await updateWorkflowChoices({
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
      action: 'add',
      inputName: 'environment',
      workflows: ['deploy.yml'],
      choiceValue: 'testing',
      commitMessage: 'Add testing environment',
      branch: 'main',
    });

    expect(result.changesMade).toBe(true);
    expect(result.updatedWorkflows).toContain('deploy.yml');
  });

  it('should skip workflow when no changes needed', async () => {
    const mockOctokit = createMockOctokit({
      getContentResponse: { content: sampleWorkflowContent, sha: 'abc123' },
    });

    const result = await updateWorkflowChoices({
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
      action: 'add',
      inputName: 'environment',
      workflows: ['deploy.yml'],
      choiceValue: 'staging', // Already exists
      commitMessage: 'Add staging environment',
      branch: 'main',
    });

    expect(result.changesMade).toBe(false);
    expect(result.updatedWorkflows).toEqual([]);
  });

  it('should skip workflow when file is not found (404)', async () => {
    const error = new Error('Not Found') as Error & { status: number };
    error.status = 404;

    const mockOctokit = createMockOctokit({
      getContentError: error,
    });

    const result = await updateWorkflowChoices({
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
      action: 'add',
      inputName: 'environment',
      workflows: ['nonexistent.yml'],
      choiceValue: 'testing',
      commitMessage: 'Add testing',
      branch: 'main',
    });

    expect(result.changesMade).toBe(false);
    expect(result.updatedWorkflows).toEqual([]);
  });

  it('should throw error for non-404 errors', async () => {
    const error = new Error('Server Error') as Error & { status: number };
    error.status = 500;

    const mockOctokit = createMockOctokit({
      getContentError: error,
    });

    await expect(
      updateWorkflowChoices({
        octokit: mockOctokit,
        owner: 'test-owner',
        repo: 'test-repo',
        action: 'add',
        inputName: 'environment',
        workflows: ['deploy.yml'],
        choiceValue: 'testing',
        commitMessage: 'Add testing',
        branch: 'main',
      })
    ).rejects.toThrow('Server Error');
  });

  it('should skip when content is not a file (no content)', async () => {
    const mockOctokit = createMockOctokit({
      getContentResponse: { sha: 'abc123' }, // No content property (directory)
    });

    const result = await updateWorkflowChoices({
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
      action: 'add',
      inputName: 'environment',
      workflows: ['deploy.yml'],
      choiceValue: 'testing',
      commitMessage: 'Add testing',
      branch: 'main',
    });

    expect(result.changesMade).toBe(false);
    expect(result.updatedWorkflows).toEqual([]);
  });

  it('should handle multiple workflows', async () => {
    const mockOctokit = createMockOctokit({
      getContentResponse: { content: sampleWorkflowContent, sha: 'abc123' },
      createOrUpdateResponse: {},
    });

    const result = await updateWorkflowChoices({
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
      action: 'add',
      inputName: 'environment',
      workflows: ['deploy.yml', 'release.yml'],
      choiceValue: 'testing',
      commitMessage: 'Add testing environment',
      branch: 'main',
    });

    expect(result.changesMade).toBe(true);
    expect(result.updatedWorkflows).toHaveLength(2);
  });
});

describe('modifyWorkflowContent', () => {
  const sampleWorkflow = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

  describe('add action', () => {
    it('should add a new choice to options', () => {
      const result = modifyWorkflowContent(sampleWorkflow, {
        action: 'add',
        inputName: 'environment',
        choiceValue: 'testing',
      });

      expect(result).toContain('testing');
      expect(result).toContain('development');
      expect(result).toContain('staging');
      expect(result).toContain('production');
    });

    it('should not duplicate existing choice', () => {
      const result = modifyWorkflowContent(sampleWorkflow, {
        action: 'add',
        inputName: 'environment',
        choiceValue: 'staging',
      });

      // Count occurrences of 'staging'
      const matches = result.match(/staging/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe('delete action', () => {
    it('should remove an existing choice', () => {
      const result = modifyWorkflowContent(sampleWorkflow, {
        action: 'delete',
        inputName: 'environment',
        choiceValue: 'staging',
      });

      expect(result).not.toContain('staging');
      expect(result).toContain('development');
      expect(result).toContain('production');
    });

    it('should not modify if choice does not exist', () => {
      const result = modifyWorkflowContent(sampleWorkflow, {
        action: 'delete',
        inputName: 'environment',
        choiceValue: 'nonexistent',
      });

      expect(result).toBe(sampleWorkflow);
    });
  });

  describe('update action', () => {
    it('should update an existing choice', () => {
      const result = modifyWorkflowContent(sampleWorkflow, {
        action: 'update',
        inputName: 'environment',
        choiceValue: 'staging',
        newChoiceValue: 'stage',
      });

      expect(result).not.toContain('staging');
      expect(result).toContain('stage');
      expect(result).toContain('development');
      expect(result).toContain('production');
    });

    it('should not modify if choice does not exist', () => {
      const result = modifyWorkflowContent(sampleWorkflow, {
        action: 'update',
        inputName: 'environment',
        choiceValue: 'nonexistent',
        newChoiceValue: 'new-value',
      });

      expect(result).toBe(sampleWorkflow);
    });
  });

  describe('edge cases', () => {
    it('should return original content if input not found', () => {
      const result = modifyWorkflowContent(sampleWorkflow, {
        action: 'add',
        inputName: 'nonexistent-input',
        choiceValue: 'value',
      });

      expect(result).toBe(sampleWorkflow);
    });

    it('should handle workflow without workflow_dispatch', () => {
      const noDispatchWorkflow = `name: CI
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
`;

      const result = modifyWorkflowContent(noDispatchWorkflow, {
        action: 'add',
        inputName: 'environment',
        choiceValue: 'value',
      });

      expect(result).toBe(noDispatchWorkflow);
    });

    it('should handle input that is not a choice type', () => {
      const stringInputWorkflow = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to deploy'
        required: true
        type: string
`;

      const result = modifyWorkflowContent(stringInputWorkflow, {
        action: 'add',
        inputName: 'version',
        choiceValue: 'v1.0.0',
      });

      expect(result).toBe(stringInputWorkflow);
    });

    it('should handle workflow with GitHub expression syntax', () => {
      const workflowWithExpressions = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Show env
        run: echo "Deploying to \${{ inputs.environment }}"
`;

      const result = modifyWorkflowContent(workflowWithExpressions, {
        action: 'add',
        inputName: 'environment',
        choiceValue: 'testing',
      });

      expect(result).toContain('testing');
      expect(result).toContain('development');
      expect(result).toContain('staging');
      expect(result).toContain('production');
    });
  });
});

describe('extractOptionsWithRegex', () => {
  const sampleWorkflow = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  deploy:
    runs-on: ubuntu-latest
`;

  it('should extract options from a valid workflow', () => {
    const options = extractOptionsWithRegex(sampleWorkflow, 'environment');
    expect(options).toEqual(['development', 'staging', 'production']);
  });

  it('should return empty array for non-existent input', () => {
    const options = extractOptionsWithRegex(sampleWorkflow, 'nonexistent');
    expect(options).toEqual([]);
  });

  it('should handle quoted option values', () => {
    const workflowWithQuotes = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      env:
        type: choice
        options:
          - "quoted-value"
          - 'single-quoted'
          - unquoted
`;
    const options = extractOptionsWithRegex(workflowWithQuotes, 'env');
    expect(options).toEqual(['quoted-value', 'single-quoted', 'unquoted']);
  });

  it('should handle multiple inputs and extract correct one', () => {
    const multiInputWorkflow = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options:
          - dev
          - prod
      region:
        type: choice
        options:
          - us-east-1
          - eu-west-1
`;
    const envOptions = extractOptionsWithRegex(multiInputWorkflow, 'environment');
    expect(envOptions).toEqual(['dev', 'prod']);

    const regionOptions = extractOptionsWithRegex(multiInputWorkflow, 'region');
    expect(regionOptions).toEqual(['us-east-1', 'eu-west-1']);
  });

  it('should handle input without options', () => {
    const noOptionsWorkflow = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      version:
        type: string
        description: Version to deploy
`;
    const options = extractOptionsWithRegex(noOptionsWorkflow, 'version');
    expect(options).toEqual([]);
  });
});

describe('replaceOptionsWithRegex', () => {
  const sampleWorkflow = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  deploy:
    runs-on: ubuntu-latest
`;

  it('should replace options with new values', () => {
    const result = replaceOptionsWithRegex(sampleWorkflow, 'environment', ['dev', 'stage', 'prod']);
    expect(result).toContain('- dev');
    expect(result).toContain('- stage');
    expect(result).toContain('- prod');
    expect(result).not.toContain('- development');
    expect(result).not.toContain('- staging');
    expect(result).not.toContain('- production');
  });

  it('should preserve other parts of the workflow', () => {
    const result = replaceOptionsWithRegex(sampleWorkflow, 'environment', ['new-option']);
    expect(result).toContain('name: Deploy');
    expect(result).toContain("description: 'Target environment'");
    expect(result).toContain('runs-on: ubuntu-latest');
  });

  it('should handle adding more options than original', () => {
    const result = replaceOptionsWithRegex(sampleWorkflow, 'environment', [
      'opt1',
      'opt2',
      'opt3',
      'opt4',
      'opt5',
    ]);
    expect(result).toContain('- opt1');
    expect(result).toContain('- opt5');
  });

  it('should handle reducing options', () => {
    const result = replaceOptionsWithRegex(sampleWorkflow, 'environment', ['only-one']);
    expect(result).toContain('- only-one');
    const matches = result.match(/^\s+- /gm);
    expect(matches?.length).toBe(1);
  });

  it('should not modify workflow if input not found', () => {
    const result = replaceOptionsWithRegex(sampleWorkflow, 'nonexistent', ['new-option']);
    expect(result).toBe(sampleWorkflow);
  });
});

describe('modifyWithFallback', () => {
  const sampleWorkflow = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  deploy:
    runs-on: ubuntu-latest
`;

  describe('add action', () => {
    it('should add a new choice', () => {
      const result = modifyWithFallback(sampleWorkflow, {
        action: 'add',
        inputName: 'environment',
        choiceValue: 'testing',
      });
      expect(result).toContain('- testing');
      expect(result).toContain('- development');
    });

    it('should not duplicate existing choice', () => {
      const result = modifyWithFallback(sampleWorkflow, {
        action: 'add',
        inputName: 'environment',
        choiceValue: 'staging',
      });
      expect(result).toBe(sampleWorkflow);
    });
  });

  describe('delete action', () => {
    it('should delete an existing choice', () => {
      const result = modifyWithFallback(sampleWorkflow, {
        action: 'delete',
        inputName: 'environment',
        choiceValue: 'staging',
      });
      expect(result).not.toContain('- staging');
      expect(result).toContain('- development');
      expect(result).toContain('- production');
    });

    it('should not modify if choice does not exist', () => {
      const result = modifyWithFallback(sampleWorkflow, {
        action: 'delete',
        inputName: 'environment',
        choiceValue: 'nonexistent',
      });
      expect(result).toBe(sampleWorkflow);
    });
  });

  describe('update action', () => {
    it('should update an existing choice', () => {
      const result = modifyWithFallback(sampleWorkflow, {
        action: 'update',
        inputName: 'environment',
        choiceValue: 'staging',
        newChoiceValue: 'stage',
      });
      expect(result).not.toContain('- staging');
      expect(result).toContain('- stage');
    });

    it('should not modify if choice does not exist', () => {
      const result = modifyWithFallback(sampleWorkflow, {
        action: 'update',
        inputName: 'environment',
        choiceValue: 'nonexistent',
        newChoiceValue: 'new-value',
      });
      expect(result).toBe(sampleWorkflow);
    });

    it('should not modify if newChoiceValue is not provided', () => {
      const result = modifyWithFallback(sampleWorkflow, {
        action: 'update',
        inputName: 'environment',
        choiceValue: 'staging',
      });
      expect(result).toBe(sampleWorkflow);
    });
  });

  describe('edge cases', () => {
    it('should return original content if input not found', () => {
      const result = modifyWithFallback(sampleWorkflow, {
        action: 'add',
        inputName: 'nonexistent',
        choiceValue: 'value',
      });
      expect(result).toBe(sampleWorkflow);
    });

    it('should handle workflow with complex expressions', () => {
      const complexWorkflow = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options:
          - development
          - staging

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      TARGET: \${{ inputs.environment }}
    steps:
      - run: echo \${{ github.repository }}
`;
      const result = modifyWithFallback(complexWorkflow, {
        action: 'add',
        inputName: 'environment',
        choiceValue: 'production',
      });
      expect(result).toContain('- production');
      expect(result).toContain('${{ inputs.environment }}');
    });
  });
});
