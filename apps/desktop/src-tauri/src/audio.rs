//! Device I/O belongs to the Host; the capture thread owns and promptly drops its WASAPI stream.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Buffer {
    pub chunks: VecDeque<Vec<u8>>,
    pub error: Option<String>,
    pub captured: f64,
}
pub fn capture(
    done: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    recording: Arc<AtomicBool>,
    buffer: Arc<Mutex<Buffer>>,
) -> mpsc::Receiver<Result<u32, String>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let device = cpal::default_host()
                .default_input_device()
                .ok_or("没有可用的麦克风，请检查 Windows 麦克风权限和设备。")?;
            let supported = device
                .default_input_config()
                .map_err(|_| "麦克风格式不可用")?;
            let rate = supported.sample_rate().0;
            let channels = supported.channels() as usize;
            let config: cpal::StreamConfig = supported.clone().into();
            let error_buffer = buffer.clone();
            let error_done = done.clone();
            let on_error = move |_error| {
                error_buffer.lock().unwrap().error = Some("麦克风连接中断".into());
                error_done.store(true, Ordering::SeqCst);
            };
            macro_rules! input {
                ($typ:ty,$convert:expr) => {{
                    let b=buffer.clone();let d=done.clone();let c=cancel.clone();
                    device.build_input_stream(&config,move |data:&[$typ],_|{
                        if d.load(Ordering::SeqCst)||c.load(Ordering::SeqCst){return;}
                        let mut b=b.lock().unwrap();
                        let remaining=((30.0-b.captured).max(0.0)*rate as f64) as usize;
                        let frames=(data.len()/channels).min(remaining);
                        let mut pcm=Vec::with_capacity(frames*2);
                        for frame in data.chunks_exact(channels).take(frames) {
                            let mono=frame.iter().map($convert).sum::<f32>()/channels as f32;
                            pcm.extend_from_slice(&((mono.clamp(-1.0,1.0)*i16::MAX as f32) as i16).to_le_bytes());
                        }
                        b.captured+=frames as f64/rate as f64;
                        if !pcm.is_empty(){b.chunks.push_back(pcm);}
                        if b.captured>=29.999 {d.store(true,Ordering::SeqCst);}
                    },on_error,None).map_err(|_|"无法打开麦克风，请检查设备占用或 Windows 权限。")?
                }};
            }
            let stream = match supported.sample_format() {
                cpal::SampleFormat::F32 => input!(f32, |x: &f32| *x),
                cpal::SampleFormat::I16 => input!(i16, |x: &i16| *x as f32 / i16::MAX as f32),
                cpal::SampleFormat::U16 => input!(u16, |x: &u16| (*x as f32 - 32768.0) / 32768.0),
                _ => return Err("此麦克风默认采样格式尚不支持，请选择标准 PCM 设备。".into()),
            };
            if cancel.load(Ordering::SeqCst) || done.load(Ordering::SeqCst) {
                let _ = tx.send(Err("录音已取消".into()));
                return Ok(());
            }
            stream.play().map_err(|_| "麦克风采集启动失败")?;
            recording.store(true, Ordering::SeqCst);
            let _ = tx.send(Ok(rate));
            let began = Instant::now();
            while !done.load(Ordering::SeqCst)
                && !cancel.load(Ordering::SeqCst)
                && began.elapsed() < Duration::from_secs(30)
            {
                thread::sleep(Duration::from_millis(10));
            }
            done.store(true, Ordering::SeqCst);
            drop(stream);
            recording.store(false, Ordering::SeqCst);
            Ok(())
        })();
        if let Err(e) = result {
            recording.store(false, Ordering::SeqCst);
            done.store(true, Ordering::SeqCst);
            let _ = tx.send(Err(e));
        }
    });
    rx
}
