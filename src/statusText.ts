export type StatusBarStyle = 'full' | 'compact';

export interface StatusInput {
    cpu: number;
    memory: number;
    warning: number;
    style: StatusBarStyle;
}

export interface StatusView {
    text: string;
    tooltip: string;
    warn: boolean;
}

/** Status bar text for the CPU and memory readout; compact trades labels for width. */
export function statusView({ cpu, memory, warning, style }: StatusInput): StatusView {
    const c = Math.round(cpu);
    const m = Math.round(memory);
    return {
        text: style === 'compact' ? `$(pulse) ${c}·${m}%` : `$(pulse) ${c}%  $(server) ${m}%`,
        tooltip: `Nano Metrics\nCPU ${c}% · Memory ${m}%\nClick to open dashboard`,
        warn: c >= warning || m >= warning
    };
}
