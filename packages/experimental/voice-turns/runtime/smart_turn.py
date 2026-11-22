"""Offline Smart Turn v3.1 reference preprocessing; no audio device or download code."""
import base64
import json
import sys

import numpy as np
import onnxruntime as ort
from transformers import WhisperFeatureExtractor

# Reference: pipecat-ai/smart-turn inference.py and audio_utils.py (BSD-2-Clause).
options = ort.SessionOptions()
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
options.inter_op_num_threads = 1
options.intra_op_num_threads = int(sys.argv[2])
options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
session = ort.InferenceSession(sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"])
extractor = WhisperFeatureExtractor(chunk_length=8)
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    audio = np.frombuffer(base64.b64decode(command["audioBase64"], validate=True), dtype="<i2").astype(np.float32) / 32768
    audio = audio[-128000:]
    audio = np.pad(audio, (128000 - len(audio), 0))
    features = extractor(audio, sampling_rate=16000, return_tensors="np", padding="max_length",
                         max_length=128000, truncation=True, do_normalize=True).input_features
    features = np.expand_dims(features.squeeze(0).astype(np.float32), axis=0)
    probability = float(session.run(None, {"input_features": features})[0][0].item())
    print(json.dumps({"probability": probability}, allow_nan=False), flush=True)
