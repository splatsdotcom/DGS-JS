#include "mgs_gaussian.hpp"

#include <iostream>
#include <limits>
#include <algorithm>
#include <thread>
#include <future>

namespace mgs
{

#define MGS_GAUSSIAN_CLIP_THRESHHOLD 1.2f
#define MGS_GAUSSIAN_MIN_SORT_SIZE 5000

//-------------------------------------------//

class ThreadPool 
{
public:
	ThreadPool(size_t threadCount) : m_shouldStop(false) 
	{
		for(size_t i = 0; i < threadCount; i++)
			m_workers.emplace_back([this]() { this->work_loop(); });
	}

	~ThreadPool() 
	{
		{
			std::unique_lock<std::mutex> lock(m_workMutex);
			m_shouldStop = true;
		}
		m_emptyCond.notify_all();

		for(auto &w : m_workers) 
			w.join();
	}

	template<class F>
	auto submit(F&& f) -> std::future<decltype(f())>
	{
		using Ret = decltype(f());
		auto task = std::make_shared<std::packaged_task<Ret()>>(std::forward<F>(f));

		{
			std::unique_lock<std::mutex> lock(m_workMutex);
			m_tasks.emplace([task]() { (*task)(); });
		}

		m_emptyCond.notify_one();

		return task->get_future();
	}

private:
	std::vector<std::thread> m_workers;
	std::queue<std::function<void()>> m_tasks;

	std::mutex m_workMutex;
	std::condition_variable m_emptyCond;
	bool m_shouldStop;

	void work_loop()
	{
		while(true)
		{
			std::function<void()> job;

			{
				std::unique_lock<std::mutex> lock(m_workMutex);

				m_emptyCond.wait(lock, [&](){ return m_shouldStop || !m_tasks.empty(); });

				if(m_shouldStop && m_tasks.empty())
					return;

				job = std::move(m_tasks.front());
				m_tasks.pop();
			}

			job();
		}
	}
};

ThreadPool g_pool(std::thread::hardware_concurrency());

//-------------------------------------------//

static inline uint32_t align(uint32_t a, uint32_t b)
{
	return (a + b - 1) & ~(b - 1);
}

//-------------------------------------------//

Gaussians::Gaussians(uint32_t _shDegree, bool _dynamic) : 
	shDegree(_shDegree), dynamic(_dynamic)
{
	if(_shDegree > MGS_MAX_SH_DEGREE)
		throw std::invalid_argument("spherical haromics degree is too large");
}

void Gaussians::add(const vec3& mean, const vec3& scale, const quaternion& rotation, 
                    float opacity, const vec3& color, const std::vector<vec3>& sh,
                    const vec3& velocity, float tMean, float tStdev)
{
	if(sh.size() != (shDegree + 1) * (shDegree + 1) - 1)
		throw std::invalid_argument("incorrect number of spherical haromics provided");

	means.push_back(mean);
	scales.push_back(scale);
	rotations.push_back(rotation);
	opacities.push_back(opacity);
	colors.push_back(color);

	for(uint32_t i = 0; i < sh.size(); i++)
		shs.push_back(sh[i]);

	if(dynamic)
	{
		velocities.push_back(velocity);
		tMeans.push_back(tMean);
		tStdevs.push_back(tStdev);
	}

	count++;
}

GaussiansPacked::GaussiansPacked(const Gaussians& gaussians) :
	shDegree(gaussians.shDegree), dynamic(gaussians.dynamic), count(gaussians.count)
{
	uint32_t numShCoeff = (shDegree + 1) * (shDegree + 1) - 1;
	
	//compute min and max for color/sh:
	//-----------------	
	colorMin =  INFINITY;
	colorMax = -INFINITY;
	shMin =  INFINITY;
	shMax = -INFINITY;

	for(uint32_t i = 0; i < count; i++)
	{
		colorMin = std::min(colorMin, gaussians.colors[i].r);
		colorMin = std::min(colorMin, gaussians.colors[i].g);
		colorMin = std::min(colorMin, gaussians.colors[i].b);

		colorMax = std::max(colorMax, gaussians.colors[i].r);
		colorMax = std::max(colorMax, gaussians.colors[i].g);
		colorMax = std::max(colorMax, gaussians.colors[i].b);

		for(uint32_t j = 0; j < numShCoeff; j++)
		{
			shMin = std::min(shMin, gaussians.shs[i * numShCoeff + j].r);
			shMin = std::min(shMin, gaussians.shs[i * numShCoeff + j].g);
			shMin = std::min(shMin, gaussians.shs[i * numShCoeff + j].b);

			shMax = std::max(shMax, gaussians.shs[i * numShCoeff + j].r);
			shMax = std::max(shMax, gaussians.shs[i * numShCoeff + j].g);
			shMax = std::max(shMax, gaussians.shs[i * numShCoeff + j].b);
		}
	}

	//pack each gaussian:
	//-----------------
	float colorScale = 1.0f / (colorMax - colorMin);
	float shScale = 1.0f / (shMax - shMin);

	means.resize(count);
	covariances.resize(count * 6);
	opacities.resize(align(count, 4));
	colors.resize(align(count * 3, 2));
	shs.resize(align(count * numShCoeff * 3, 4));

	if(dynamic)
		velocities.resize(count);
	
	for(uint32_t i = 0; i < count; i++)
	{
		//mean:
		means[i] = vec4(
			gaussians.means[i], 
			dynamic ? gaussians.tMeans[i] : 0.0f
		);

		//covariance
		mat4 M = qm::scale(gaussians.scales[i]) * quaternion_to_mat4(gaussians.rotations[i]);
		float covariance[6] = {
			M[0][0] * M[0][0] + M[0][1] * M[0][1] + M[0][2] * M[0][2],
			M[0][0] * M[1][0] + M[0][1] * M[1][1] + M[0][2] * M[1][2],
			M[0][0] * M[2][0] + M[0][1] * M[2][1] + M[0][2] * M[2][2],
			M[1][0] * M[1][0] + M[1][1] * M[1][1] + M[1][2] * M[1][2],
			M[1][0] * M[2][0] + M[1][1] * M[2][1] + M[1][2] * M[2][2],
			M[2][0] * M[2][0] + M[2][1] * M[2][1] + M[2][2] * M[2][2]
		};

		for(uint32_t j = 0; j < 6; j++)
			covariances[i * 6 + j] = 4.0f * covariance[j];

		//opacity
		opacities[i] = (uint8_t)(gaussians.opacities[i] * UINT8_MAX);

		//color
		colors[i * 3 + 0] = (uint16_t)((gaussians.colors[i].r - colorMin) * colorScale * UINT16_MAX);
		colors[i * 3 + 1] = (uint16_t)((gaussians.colors[i].g - colorMin) * colorScale * UINT16_MAX);
		colors[i * 3 + 2] = (uint16_t)((gaussians.colors[i].b - colorMin) * colorScale * UINT16_MAX);

		//sh
		for(uint32_t j = 0; j < numShCoeff; j++)
		{
			uint32_t idx = (i * numShCoeff + j) * 3;
			shs[idx + 0] = (uint8_t)((gaussians.shs[i * numShCoeff + j].r - shMin) * shScale * UINT8_MAX);
			shs[idx + 1] = (uint8_t)((gaussians.shs[i * numShCoeff + j].g - shMin) * shScale * UINT8_MAX);
			shs[idx + 2] = (uint8_t)((gaussians.shs[i * numShCoeff + j].b - shMin) * shScale * UINT8_MAX);
		}

		//velocity:
		if(dynamic)
			velocities[i] = vec4(gaussians.velocities[i], gaussians.tStdevs[i]);
	}
}

GaussiansPacked::GaussiansPacked(const std::vector<uint8_t>& serialized)
{
	const uint8_t* ptr = serialized.data();
	size_t remaining = serialized.size();

	auto read = [&](void* dst, size_t size) {
		if(remaining < size) 
			throw std::runtime_error("GaussiansPacked: truncated input");

		std::memcpy(dst, ptr, size);
		ptr += size;
		remaining -= size;
	};

	//read header:
	//-----------------
	read(&shDegree, sizeof(uint32_t));
	read(&dynamic, sizeof(bool));
	read(&count, sizeof(uint32_t));
	read(&colorMax, sizeof(float));
	read(&colorMin, sizeof(float));
	read(&shMax, sizeof(float));
	read(&shMin, sizeof(float));

	uint32_t numShCoeff = (shDegree + 1) * (shDegree + 1) - 1;
	
	//read data:
	//-----------------
	auto read_vector = [&](auto& v, size_t numElems) {
		using T = typename std::remove_reference<decltype(v[0])>::type;
		v.resize(numElems);
		size_t bytes = numElems * sizeof(T);
		read(v.data(), bytes);
	};

	read_vector(means, count);
	read_vector(covariances, count * 6);
	read_vector(opacities, align(count, 4));
	read_vector(colors, align(count * 3, 2));
	read_vector(shs, align(count * numShCoeff * 3, 4));
	if(dynamic)
		read_vector(velocities, count);

	//validate:
	//-----------------
	if(remaining != 0)
		throw std::runtime_error("GaussiansPacked: extra bytes at end of input");
}

std::vector<uint8_t> GaussiansPacked::serialize() const
{
	std::vector<uint8_t> data;

	//write header:
	//-----------------
	auto append = [&](const void* src, size_t size) {
		size_t offset = data.size();
		data.resize(offset + size);
		std::memcpy(data.data() + offset, src, size);
	};

	append(&shDegree, sizeof(shDegree));
	append(&dynamic, sizeof(dynamic));
	append(&count, sizeof(count));
	append(&colorMax, sizeof(colorMax));
	append(&colorMin, sizeof(colorMin));
	append(&shMax, sizeof(shMax));
	append(&shMin, sizeof(shMin));

	//write data:
	//-----------------
	auto append_vector = [&](auto const& v) {
		if(!v.empty())
			append(v.data(), v.size() * sizeof(v[0]));
	};

	append_vector(means);
	append_vector(covariances);
	append_vector(opacities);
	append_vector(colors);
	append_vector(shs);
	if(dynamic)
		append_vector(velocities);

	return data;
}

GaussianSorter::GaussianSorter(const std::shared_ptr<GaussiansPacked>& gaussians) :
	m_gaussians(gaussians)
{
	
}

void GaussianSorter::sort(const mat4& view, const mat4& proj, float time,
						  bool isAsync)
{
	//validate:
	//-----------------
	if(!isAsync && m_asyncThreadData.active)
		throw std::runtime_error("a background thread is already sorting");

	//compute partition ranges:
	//-----------------
	uint32_t numParts = std::min<uint32_t>(
		std::thread::hardware_concurrency(),
		std::max<uint32_t>(1, m_gaussians->count / MGS_GAUSSIAN_MIN_SORT_SIZE)
	);

	std::vector<uint32_t> partStarts(numParts), partEnds(numParts);
	uint32_t partSize = m_gaussians->count / numParts;
	uint32_t partRemainder = m_gaussians->count % numParts;

	for(uint32_t i = 0; i < numParts; i++) 
	{
		uint32_t num = partSize + (i < partRemainder ? 1 : 0);
		uint32_t start = partSize * i + std::min(i, partRemainder);

		partStarts[i] = start;
		partEnds[i] = start + num;
	}

	//sort partitions in parallel:
	//-----------------
	std::vector<std::vector<std::pair<uint32_t,float>>> toSort(numParts);

	std::vector<std::future<void>> futures;
	futures.reserve(numParts);

	for(uint32_t i = 0; i < numParts; ++i) 
	{
		futures.emplace_back(g_pool.submit([&, i]() {
			auto& local = toSort[i];
			local.reserve(static_cast<size_t>(partEnds[i] - partStarts[i]));

			for(uint32_t j = partStarts[i]; j < partEnds[i]; ++j) 
			{
				vec3 mean = m_gaussians->means[j].xyz() + m_gaussians->velocities[j].xyz() * time;

				vec4 camPos  = view * vec4(mean, 1.0f);
				vec4 clipPos = proj * camPos;

				float clip = MGS_GAUSSIAN_CLIP_THRESHHOLD * clipPos.w;
				if(clipPos.x >  clip || clipPos.y >  clip || clipPos.z >  clip ||
				   clipPos.x < -clip || clipPos.y < -clip || clipPos.z < -clip)
					continue;

				local.emplace_back(j, camPos.z);
			}

			std::sort(
				local.begin(), local.end(),
				[](auto &a, auto &b){ return a.second > b.second; }
			);
		}));
	}

	for(auto& f: futures) 
		f.get();

	//compute total culled size:
	//-----------------
	size_t totalSize = 0;
	size_t numNonemptyParts = 0;
	for(auto& v: toSort) 
	{
		totalSize += v.size();
		if(!v.empty()) 
			numNonemptyParts++;
	}

	if(totalSize == 0) 
	{
		m_indices.clear();
		return;
	}

	//perform a tree merge reduction:
	//-----------------
	auto mergeTwo = [](const std::vector<std::pair<uint32_t, float>>& a,
					   const std::vector<std::pair<uint32_t, float>>& b,
					   std::vector<std::pair<uint32_t, float>>& out)
	{
		out.clear();
		out.reserve(a.size() + b.size());

		size_t i = 0, j = 0;
		while(i < a.size() && j < b.size()) 
		{
			if(a[i].second > b[j].second) 
				out.push_back(a[i++]);
			else 
				out.push_back(b[j++]);
		}

		while(i < a.size()) 
			out.push_back(a[i++]);
		while(j < b.size()) 
			out.push_back(b[j++]);
	};

	std::vector<std::vector<std::pair<uint32_t, float>>> toMerge;
	toMerge.reserve(numParts);

	for(auto& v: toSort) 
		if(!v.empty()) 
			toMerge.push_back(std::move(v));

	while(toMerge.size() > 2) 
	{
		size_t activeCount = toMerge.size();
		size_t nextCount = (activeCount + 1) / 2;
		std::vector<std::vector<std::pair<uint32_t, float>>> next;
		next.resize(nextCount);

		std::vector<std::future<void>> mergeFutures;
		mergeFutures.reserve(activeCount / 2);

		for(size_t i = 0; i < activeCount; i += 2) 
		{
			size_t outIdx = i / 2;
			if(i + 1 == activeCount) 
				next[outIdx] = std::move(toMerge[i]);
			else 
			{
				mergeFutures.emplace_back(g_pool.submit([&, l = i, r = i + 1, out = outIdx]() {
					mergeTwo(toMerge[l], toMerge[r], next[out]);
				}));
			}
		}

		for(auto &mf: mergeFutures) 
			mf.get();

		toMerge.swap(next);
	}

	//merge final 2 arrays into out indices:
	//-----------------
	if(toMerge.size() == 1)
	{
		auto &v = toMerge[0];
		m_indices.resize(v.size());
		for(size_t k = 0; k < v.size(); k++)
			m_indices[k] = v[k].first;
	}
	else
	{
		auto& a = toMerge[0];
		auto& b = toMerge[1];

		m_indices.resize(a.size() + b.size());

		size_t i = 0, j = 0, out = 0;
		while(i < a.size() && j < b.size())
		{
			if(a[i].second > b[j].second)
				m_indices[out++] = a[i++].first;
			else
				m_indices[out++] = b[j++].first;
		}

		while(i < a.size()) 
			m_indices[out++] = a[i++].first;
		while(j < b.size()) 
			m_indices[out++] = b[j++].first;
	}
}


void GaussianSorter::sort_async_start(const mat4& view, const mat4& proj, float time)
{
	if(m_asyncThreadData.active)
		throw std::runtime_error("a background thread is already sorting");

	m_asyncThreadData.active = true;
	m_asyncThreadData.view = view;
	m_asyncThreadData.proj = proj;
	m_asyncThreadData.time = time;
	m_asyncThreadData.sorter = this;

	if(pthread_create(&m_asyncThreadData.thread, nullptr, &GaussianSorter::start_async_thread, &m_asyncThreadData))
		throw std::runtime_error("pthread_create failed");
}

bool GaussianSorter::sort_async_pending() const
{
	return m_asyncThreadData.active;
}

bool GaussianSorter::sort_async_tryjoin()
{
	if(!m_asyncThreadData.active)
		throw std::runtime_error("no background thread is running");
	
	int joinResult = pthread_tryjoin_np(m_asyncThreadData.thread, nullptr);
	if(joinResult == EBUSY)
		return false;

	m_asyncThreadData.active = false;
	return true;
}

const std::vector<uint32_t>& GaussianSorter::get_latest() const
{
	return m_indices;
}

void* GaussianSorter::start_async_thread(void* arg)
{
	AsyncThreadData* data = static_cast<AsyncThreadData*>(arg);
	data->sorter->sort(data->view, data->proj, data->time, true);

	return nullptr;
}

}; //namespace mgs