# Comfyui-PWUtility
Contain a some useful nodes, like bool to set group state, group switch state advanced.

## Bool Group Switch节点
预先设置多个节点组们在true和false下的状态，通过bool值来统一进行切换，以达到通过bool来控制工作流的效果。

<img width="828" height="1000" alt="BoolGroupSwitch" src="https://github.com/user-attachments/assets/f0931173-31bc-4110-9ae0-ae18fda6d89b" />

该节点要位于设置组们的前方。这样可以让流程先通过这个节点来设置组的状态。在trigger中输入的数据从data_out输出(不会改变数据)。再流入最近的要设置的组，就控制了生成的顺序，防止先跑这些组再跑这个节点。Trigger并不是必须的，但是要控制具体的生成顺序最好是使用trigger。

interrupt_node_id：输入一个节点的ID，当执行到该节点时，流程会被打断，然后重新执行，用这样的方式来设置组们的状态。该节点最好是位于Bool Group Switch下游，并且不参与设置组们的执行，同时又很轻的节点。当前面没有clear cache之类的节点时，前面跑过的节点不会重新跑。id=0则不会打断，由comfyui执行工作流。
comfyui在run工作流之前会输入整个画布所有节点的状态，因此通过这个节点调整的状态(即使视觉上改变了，实际上还是在跑的）只能在下次运行时才起效，尤其是组中有采样之类的很重的节点，就很浪费时间，因此要进行打断再重跑的方式。

Comfyui的switch类的节点，除了有lazy标记的（比如anyswitch), run的时候基本上两条路都会运行一下，选择需要的那条，如果有比较重的节点，就很浪费时间了，只有bypass/mute这种才是真正的不运行。

## Group Switch ADV节点：
组的快速开关并可联动其它组进行联级开关。

<img width="673" height="480" alt="GroupSwitchADV1" src="https://github.com/user-attachments/assets/0103910a-87d5-496d-9a05-695074e6ea68" />

Linkage Config中，通过点击右侧加号添加组并设置组的状态。组的左侧+可快速添加该组另一种状态。
一个组(Group1)可以联动另一个组（Group2)并进而联动Group2联动的Group3。但是当Group1中也设置Group3并且与Group2中的状态矛盾时，以Group1也就是主动切换的那个为准。

<img width="419" height="318" alt="GroupSwitchADV2" src="https://github.com/user-attachments/assets/146a684a-89d1-4042-8bea-92d7b8964e19" />

该节点也支持子图。子图中的组会用"子图名：组名"这样的方式显示在面版中。

当组的名字发生改变，该组会继承原组的linkage，并且其它组的linkage中如果有涉及到该组的也会自动改变组名。这是通过给予唯一的组ID并进行追踪实现，同时添加了title+path的快照备份，使得及时将该节点和相关组复制到其它工作流时，ID发生改变，可由title和path来重新与新ID进行连接，使得跨工作流复制不存在问题。

## Image Loader PW：
本地上传图片(可多图），并调整尺寸。

### Upload Images：本地上传图片，可多图批量上传。
- 支持拖拽上传。
- 支持拖拽改变顺序。
- 图片中心出现✂️图案可对图片进行手动crop。

### scale mode: 选择缩放方式。
#### scale dimensions：设置宽和高。
- 长宽都为0则是保持原图尺寸。注意，此时是绕开multiple_of的，真正的原图不做任何修改直出！
- 但是会遇到比例问题，通过下面的resize_method来进行计算，会将长和宽更快达到给定值的设置为给定值，另一边根据resize mothod的设定的方式重新进行计算。

### multiple_of：要求长宽都能被该数值整除。

### resize_method： 选择用于处理比例的方式。
- 包括keep proportion保持原图比例，stretch拉伸，crop, pad。
- 但是可能造成与multiple_of的值的矛盾：当选择keep proportion，且保持原图比例导致长宽某一边的尺寸无法满足被multiple_of整除时，会自动降级为stretch，造成轻微形变（通常不超过1%）以满足能被multiple of整除的要求。选择pad或者crop，则会严格计算出multiple of的倍数作为边界框进行crop或者pad填充尺寸。
- crop：先按照比例进行缩放到外圈覆盖目标尺寸，然后根据crop_position计算裁剪起始坐标 x 和 y，从而精准切出目标画面。left和right只适用于横向图片，用于纵向图片和center效果一样。top和bottom只针对纵向图片。

## Video Loader PW
用于加载视频，并包含视频长度调整，视频分割标记等功能。可以与[local media manager](https://github.com/Firetheft/ComfyUI_Local_Media_Manager)联合使用
<img width="892" height="1000" alt="VideoLoaderPW" src="https://github.com/user-attachments/assets/bb87dd29-1c40-41cf-8e6a-eb04628197f3" />

### 预览窗口
预览窗口中，可以用蓝色滑块切掉视频前段和后端，显示time,frames, 源视频的fps以及crop。
- crop可以对视频进行画面裁切，点击开始显示蓝色，并进行crop操作，再次点击恢复白色，crop无效。
- 面板上的start/end，都是基于原始视频进行计算的，仅用于方便操作，并不一定等于最终值(主要是因为有align_8n+1和视频前后端裁切，会自动计算）。最终值以输出端口的值为准。

### Split_count
对视频(包括音频）进行分割。
- 0不开启。
- 1为添加一个分割点也就是视频分割为两段。此时会在预览窗口的时间轴上添加紫色滑块，用于设定精确的分割点。此时可以选择是紫色段还是蓝色段作为generate进行生成，如果选择紫色，则该段为generate，蓝色段为back，反之紫色为front, 蓝色段为generate（跟8n+1计算有关)。
- 2为添加两个分割点，就是视频分割为三段，此时会在预览窗口的时间轴上多添加一个绿色滑块。
分割点的这一帧属于其右侧这段视频，是作为该段视频的首帧。
使用分割后，split_info节点将输出分割信息，可使用Video Splitter PW节点进行视频和音频的同步分割。Video Loader PW仅提供分割点的标记信息不提供分割。

### align_8n+1
开启则将视频强制延长以符合LTX 需要8N+1的效果。
当它开启并且split_count=0时，将重复复制最后一帧到最后来补全不够的帧，并且repeat_last_frame_count将输出补全的帧数(差额，最后一帧复制了多少份),同时如果视频是带有音频的，就会用空音频接在后方进行补全。可以在生成后用remove_video_from_end节点将这几帧进行切除。
分为两段，则向front段或者back段获取需要的帧数以确保split_generate符合8n+1，而分为三段时，是向back段获取需要的帧数。
符合8n+1的也符合4n+1，就不再添加4n+1了。

## video_splitter_pw
执行视频分割的节点。
split_info拥有最高优先级，当有分割信息输入时，会忽略该节点本身的分割设置。当split_info不含有分割信息(数据为{}),才会读取该节点本身的分割设置。如果本身没有分割，则直接将输入的视频输出。
本身的分割同样是设置分割点。分割点属于下一段视频，为下段视频的首帧。
分割为两段时，固定前一段为front, 后段为generate。
分割为三段时，固定第一段为front, 第二段为generate, 第三段为back。split_back_point_idx输入后端的分割点，支持输入负数作为倒数多少帧，切割起来更方便些。

## Audio Loader PW
可以与[local media manager](https://github.com/Firetheft/ComfyUI_Local_Media_Manager)联合使用

## Audio detector PW
该节点可用于检测音频中拥有有效声音的片段，并输出该段的时间范围(以字符进行输出：开始秒数-结束秒数)。常用在将无背景的语音中检测语音从何时开始和结束。
- threshold (阈值)：判断音频波形是否发生“起伏”的标准。如果音频底噪较大，可以适当调高此值；如果声音较小，可以调低。音频如果用提取人声先进行处理，则不用改这个值保持默认。
- min_silence_ignore (最小静音间隔)：如果两段起伏之间的空白直线段（静音）短于这个时间，它们会被合并成一段输出而忽略设定值的空音频。这可以防止因为发音中正常的极短停顿（如单词之间的换气）而把一句话切得稀碎。
- window_size_ms (窗口大小)：算法将音频切片成多少毫秒的块来检测。20.0ms 是语音检测中的黄金标准，能够平滑掉极短的毛刺。

## Text Bridge PW
用于文本的获取、预览和修改。
- 从输入端获取文本并显示。可直接在此节点上进行修改，并将修改内容保存在此节点中，这样修改的文本会被保存下来。
- 当上游节点有新的文本时才会自动获取新文本并覆盖当前文本。可将上游节点mute掉以防止意外的触发覆盖掉修改的内容。
- 点击update from input，强制从上游重新获取文本并覆盖掉当前文本。一般情况下，如果上游没有修改并且cache没有被清除，则会直接取回刚才的内容。如果有修改或者无cache，update from input会触发上游节点重新运行。

## License

MIT

## Credits

- [zhihui_nodes_comfyui](https://github.com/zhihui6/zhihui_nodes_comfyui) Group Switch Manager
- [WhatDreamsCost-ComfyUI](https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI)
- [myWhatDreamsCost-ComfyUI](https://github.com/huanggou666/myWhatDreamsCost-ComfyUI)
