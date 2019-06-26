import * as cliInstance from './cli';
import { ProviderResult, TreeItemCollapsibleState, window, Terminal, Uri, commands, QuickPickItem, workspace } from 'vscode';
import { WindowUtil } from './util/windowUtils';
import { CliExitData } from './cli';
import * as path from 'path';
import { ToolsConfig } from './tools';
import format =  require('string-format');
import { PipelineExplorer } from './pipeline/pipelineExplorer';
import { wait } from './util/async';
import { statSync } from 'fs';
import bs = require('binary-search');
import { Platform } from './util/platform';
import { pipeline } from 'stream';

export interface TektonNode extends QuickPickItem {
    contextValue: string;
    comptype ?: string;
    getChildren(): ProviderResult<TektonNode[]>;
    getParent(): TektonNode;
    getName(): string;
}

export enum ContextType {
    TASK = 'task',
    TASKRUN = 'taskrun',
    PIPELINE = 'pipeline',
    PIPELINERUN = 'pipelinerun',
    CLUSTERTASK = 'clustertask'
}

function verbose(_target: any, key: string, descriptor: any) {
	let fnKey: string | undefined;
	let fn: Function | undefined;

	if (typeof descriptor.value === 'function') {
		fnKey = 'value';
		fn = descriptor.value;
	} else {
		throw new Error('not supported');
	}

	descriptor[fnKey] = function (...args: any[]) {
        const v = workspace.getConfiguration('tektonPipeline').get('outputVerbosityLevel');
        const command = fn!.apply(this, args);
        return command + (v > 0 ? ` -v ${v}` : '');
	};
}

export class Command {
    static startPipeline(name: string) {
        return 'tkn pipeline start ${name}';
    }
    static listPipelines() {
        return 'tkn pipeline list';
    }
    static describePipelines(name: string) {
        return 'tkn pipeline describe';
    }
    static listPipelineRuns(name: string) {
        return 'tkn pipelinerun list';
    }
    static describePipelineRuns(name: string) {
        return 'tkn pipelinerun describe ${name}';
    }
    static showPipelineRunLogs(name: string) {
        return 'tkn pipelinerun logs ${name}';
    }
    static listTasks(name: string) {
        return 'tkn task list ${name}';
    }
    static listTaskRuns(name: string) {
        return 'tkn taskrun list ${name}';
    }
/*     static describeTaskRuns(name: string) {
        return 'tkn taskrun list ${name}';
    } */
    static showTaskRunLogs(name: string) {
        return 'tkn taskrun logs ${name}';
    }
    static printTknVersion() {
        return 'tkn version';
    }
    static addNewPipelineFromFolder(pipeline: TektonNode, path: string) {
        return 'tkn pipeline start path';
    }
    static pushPipeline(pipeline: TektonNode): string {
        return "A string";
    }
    //TODO: Watch components as per odo so that we can reconcile pipeline view properly
    //TODO: Create and delete pipelines
    //TODO: Should Clustertasks also be found by tkn?
}

export class TektonNodeImpl implements TektonNode {
    private readonly CONTEXT_DATA = {
        pipeline: {
            icon: 'pipe.png',
            contextApi: 'tekton.pipeline',
            tooltip: 'Pipeline: {label}',
            getChildren: () => this.tkn.getPipelines()
        },
        pipelinerun: {
            icon: 'pipe.png',
            contextApi: 'tekton.pipelinerun',
            tooltip: 'PipelineRun: {label}',
            getChildren: () => this.tkn.getPipelineRuns(this)
        },
        task: {
            icon: 'task.png',
            contextApi: 'tekton.task',
            tooltip: 'Task: {label}',
            getChildren: () => this.tkn.getTasks(this)
        },
        taskrun: {
            icon: 'task.png',
            contextApi: 'tekton.taskrun',
            tooltip: 'TaskRun: {label}',
            getChildren: () => this.tkn.getTaskRuns(this)
        },
        clustertask: {
            icon: 'clustertask.png',
            contextApi: 'tekton.clustertask',
            tooltip: 'Clustertask: {label}',
            getChildren: () => this.tkn.getClusterTasks(this)
        }
    };

    constructor(private parent: TektonNode,
        public readonly name: string,
        public readonly context: ContextType,
        private readonly tkn: Tkn,
        public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.Collapsed,
        public readonly comptype?: string) {

    }
    
    get iconPath(): Uri {
        return Uri.file(path.join(__dirname, "../images", this.CONTEXT_DATA[this.context].icon));
    }

    get tooltip(): string {
        return format(this.CONTEXT_DATA[this.context].tooltip, this);
    }

    get label(): string {
        return this.name;
    }

    get contextValue() {
        return this.CONTEXT_DATA[this.context].contextApi;
    }

    getName(): string {
        return this.name;
    }

    getChildren(): ProviderResult<TektonNode[]> {
        return this.CONTEXT_DATA[this.context].getChildren();
    }

    getParent(): TektonNode {
        return this.parent;
    }
}

export interface Tkn {
    startPipeline(pipeline: TektonNode): Promise<TektonNode[]>;
    getPipelines(): Promise<TektonNode[]>;
    describePipeline(pipeline: TektonNode): Promise<TektonNode[]>;
    getPipelineRuns(pipelineRun: TektonNode): Promise<TektonNode[]>;
    describePipelineRun(pipelineRun: TektonNode): Promise<TektonNode[]>;
    showPipelineRunLogs(pipelineRun: TektonNode): Promise<TektonNode[]>;
    getTasks(task: TektonNode): Promise<TektonNode[]>;
//    describeTask(task: TektonNode): Promise<TektonNode[]>;
    getTaskRuns(taskRun: TektonNode): Promise<TektonNode[]>;
    showTaskRunLogs(taskRun: TektonNode): Promise<TektonNode[]>;
//    describeTaskRuns(taskRun: TektonNode): Promise<TektonNode[]>;
    getComponentTypeVersions(componentName: string): Promise<string[]>;
    getClusterTasks(clusterTask: TektonNode): Promise<TektonNode[]>;
    describeClusterTasks(clusterTask: TektonNode): Promise<TektonNode[]>;
    execute(command: string, cwd?: string, fail?: boolean): Promise<CliExitData>;
    executeInTerminal(command: string, cwd?: string): void;
    addPipelineFromFolder(pipeline: TektonNode, path: string): Promise<TektonNode>;
    addTaskFromFolder(pipeline: TektonNode, path: string): Promise<TektonNode>;
    addClusterTaskFromFolder(pipeline: TektonNode, path: string): Promise<TektonNode>;
    clearCache?(): void;
}

export function getInstance(): Tkn {
    return TknImpl.Instance;
}

function compareNodes(a, b): number {
    if (!a.contextValue) { return -1; }
    if (!b.contextValue) { return 1; }
    const t = a.contextValue.localeCompare(b.contextValue);
    return t ? t : a.label.localeCompare(b.label);
}

export class TknImpl implements Tkn {

    private ROOT: TektonNode = new TektonNodeImpl(undefined, 'root', undefined, undefined);
    private cache: Map<TektonNode, TektonNode[]> = new Map();
    private static cli: cliInstance.ICli = cliInstance.Cli.getInstance();
    private static instance: Tkn;

    private constructor() {}

    public static get Instance(): Tkn {
        if (!TknImpl.instance) {
            TknImpl.instance = new TknImpl();
        }
        return TknImpl.instance;
    }

    //probably need to verify cluster is up first--kube
    async getPipelines(): Promise<TektonNode[]> {
        if (!this.cache.has(this.ROOT)) {
            this.cache.set(this.ROOT, await this._getPipelines());
        }
        return this.cache.get(this.ROOT);
    }

    public async _getPipelines(): Promise<TektonNode[]> {
        let data: any[] = []; 
        const result: cliInstance.CliExitData = await this.execute(Command.listPipelines(), process.cwd(), false);
        if (result.stderr) {
            return[new TektonNodeImpl(null, result.stderr, ContextType.PIPELINE, TknImpl.instance, TreeItemCollapsibleState.None)];
        }
        try {
            data = JSON.parse(result.stdout).items;
        } catch (ignore) {
            //show no pipelines if output is not correct json
        }
        let pipelines: string[] = data.map((value) => value.metadata.name);
        pipelines = [...new Set(pipelines)];
        return pipelines.map<TektonNode>((value)=> new TektonNodeImpl(undefined, value, ContextType.PIPELINE, TknImpl.instance)).sort(compareNodes);
    }

    getPipelineRuns(pipelineRun: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    getTasks(task: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    getTaskRuns(taskRun: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    getComponentTypeVersions(componentName: string): Promise<string[]> {
        throw new Error("Method not implemented.");
    }
    getClusterTasks(clusterTask: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    startPipeline(pipeline: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    describePipeline(pipeline: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    describePipelineRun(pipelineRun: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    getPipelineRunLogs(pipelineRun: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    getTaskRunLogs(taskRun: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    describeClusterTasks(clusterTask: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }

    public async executeInTerminal(command: string, cwd: string = process.cwd(), name: string = 'Tekton') {
        const cmd = command.split(' ')[0];
        let toolLocation = await ToolsConfig.detectOrDownload();
        if (toolLocation) {
            toolLocation = path.dirname(toolLocation);
        }
        const terminal: Terminal = WindowUtil.createTerminal(name, cwd, toolLocation);
        terminal.sendText(command, true);
        terminal.show();
    }

    public async execute(command: string, cwd?: string, fail: boolean = true): Promise<CliExitData> {
        const toolLocation = await ToolsConfig.detectOrDownload();
        return TknImpl.cli.execute(
            toolLocation ? command.replace('tkn', `"${toolLocation}"`).replace(new RegExp(`&& tkb`, 'g'), `&& "${toolLocation}"`) : command,
            cwd ? {cwd} : { }
        ).then(async (result) => result.error && fail ?  Promise.reject(result.error) : result).catch((err) => fail ? Promise.reject(err) : Promise.resolve({error: null, stdout: '', stderr: ''}));
}

    private insertAndReveal(array: TektonNode[], item: TektonNode): TektonNode {
        const i = bs(array, item, compareNodes);
        array.splice(Math.abs(i) - 1, 0, item);
        PipelineExplorer.getInstance().reveal(item);
        return item;
    }
    showPipelineRunLogs(pipelineRun: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    showTaskRunLogs(taskRun: TektonNode): Promise<TektonNode[]> {
        throw new Error("Method not implemented.");
    }
    addTaskFromFolder(pipeline: TektonNode, path: string): Promise<TektonNode> {
        throw new Error("Method not implemented.");
    }
    addClusterTaskFromFolder(pipeline: TektonNode, path: string): Promise<TektonNode> {
        throw new Error("Method not implemented.");
    }
    pushPipeline(pipeline: TektonNode) {
        throw new Error("Method not implemented.");
    }
    public async addPipelineFromFolder(application: TektonNode, path: string): Promise<TektonNode> {
        await this.execute(Command.startPipeline(application.getParent().getName()));
        this.executeInTerminal(Command.pushPipeline(application), "randomstring1", "randomstring2");
        return this.insertAndReveal(await this.getPipelines(), new TektonNodeImpl(application, "test", ContextType.PIPELINE, this, TreeItemCollapsibleState.Collapsed, 'folder'));
    }

    clearCache() {
        this.cache.clear();
    }
}