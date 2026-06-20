import torch
import numpy as np

class AudioDetectorPW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "threshold": ("FLOAT", {
                    "default": 0.01,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.001,
                    "display": "number",
                    "tooltip": "触发记录的波形起伏阈值 (AC RMS)"
                }),
                # 修改点1 & 2：移动到 window_size_ms 上方，改名并修改默认值为 0.8
                "min_silence_ignore": ("FLOAT", {
                    "default": 0.8,
                    "min": 0.0,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "number",
                    "tooltip": "忽略的最小静音间隔(秒)，短于此时间的静音会被合并，避免把一句话切碎"
                }),
                "window_size_ms": ("FLOAT", {
                    "default": 20.0,
                    "min": 5.0,
                    "max": 100.0,
                    "step": 1.0,
                    "display": "number",
                    "tooltip": "滑动检测窗口大小(毫秒)，用于平滑检测"
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("time_segments",)
    FUNCTION = "detect"
    CATEGORY = "🔮PWUtility/Audio"

    # 修改点3：同步更新方法参数名和顺序
    def detect(self, audio, threshold, min_silence_ignore, window_size_ms):
        # 1. 解析输入音频和采样率
        if isinstance(audio, dict):
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        elif isinstance(audio, torch.Tensor):
            waveform = audio
            sample_rate = 44100
        else:
            waveform = audio
            sample_rate = 44100

        # 2. 转换为 numpy 数组
        if isinstance(waveform, torch.Tensor):
            audio_np = waveform.cpu().numpy()
        else:
            audio_np = np.array(waveform)

        # 3. 处理多声道，统一转为单声道
        if audio_np.ndim > 1:
            if audio_np.ndim == 3:
                audio_np = audio_np[0]
            if audio_np.ndim == 2:
                if audio_np.shape[0] < audio_np.shape[1]:
                    audio_np = np.mean(audio_np, axis=0)
                else:
                    audio_np = np.mean(audio_np, axis=1)
                    
        audio_np = audio_np.flatten()
        
        if len(audio_np) == 0:
            return ("",)

        # 4. 计算滑动窗口的 RMS 能量来检测“起伏”
        window_samples = max(1, int((window_size_ms / 1000.0) * sample_rate))
        num_windows = len(audio_np) // window_samples
        is_active = np.zeros(num_windows, dtype=bool)
        
        for i in range(num_windows):
            start_idx = i * window_samples
            end_idx = start_idx + window_samples
            window = audio_np[start_idx:end_idx]
            
            # 核心逻辑：减去均值消除直流偏移(DC Offset)
            window_ac = window - np.mean(window)
            rms = np.sqrt(np.mean(np.square(window_ac)))
            
            if rms > threshold:
                is_active[i] = True
                
        # 5. 提取连续的活动片段
        padded = np.pad(is_active.astype(int), (1, 1), 'constant')
        diffs = np.diff(padded)
        
        starts = np.where(diffs == 1)[0]
        ends = np.where(diffs == -1)[0]
        
        # 修改点4：同步内部变量名
        min_silence_windows = max(1, int((min_silence_ignore * 1000.0) / window_size_ms))
        
        merged_starts = []
        merged_ends = []
        
        if len(starts) > 0:
            current_start = starts[0]
            current_end = ends[0]
            
            for i in range(1, len(starts)):
                if starts[i] - current_end < min_silence_windows:
                    current_end = ends[i]
                else:
                    merged_starts.append(current_start)
                    merged_ends.append(current_end)
                    current_start = starts[i]
                    current_end = ends[i]
            merged_starts.append(current_start)
            merged_ends.append(current_end)
            
        # 6. 转换为时间字符串格式
        time_segments = []
        for s, e in zip(merged_starts, merged_ends):
            start_time = (s * window_samples) / sample_rate
            end_time = (e * window_samples) / sample_rate
            
            # 格式化为 "开始时间-结束时间" (保留3位小数)
            time_segments.append(f"{start_time:.3f}-{end_time:.3f}")
            
        # 使用逗号拼接多段结果
        result_string = ",".join(time_segments)
        
        return (result_string,)

# ComfyUI 节点注册字典
NODE_CLASS_MAPPINGS = {
    "audio_detector_pw": AudioDetectorPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "audio_detector_pw": "Audio Detector PW"
}