#include "mgs_sorter.hpp"

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

Sorter::Sorter(const std::shared_ptr<MGSgaussians>& gaussians) :
	m_gaussians(gaussians)
{
	
}

Sorter::~Sorter()
{
	if(m_asyncThreadData.active)
		pthread_join(m_asyncThreadData.thread, nullptr);
}

void Sorter::sort(const QMmat4& view, const QMmat4& proj, float time,
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
				QMvec3 mean = {
					m_gaussians->means[j].x,
					m_gaussians->means[j].y,
					m_gaussians->means[j].z
				};
				if(m_gaussians->dynamic)
				{
					mean = qm_vec3_add(
						mean,
						qm_vec3_scale(
							(QMvec3){ m_gaussians->velocities[j].x, m_gaussians->velocities[j].y, m_gaussians->velocities[j].z },
							time
						)
					);
				}

				QMvec4 camPos  = qm_mat4_mult_vec4(
					view,
					(QMvec4){ mean.x, mean.y, mean.z, 1.0f }
				);
				QMvec4 clipPos = qm_mat4_mult_vec4(proj, camPos);

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


void Sorter::sort_async_start(const QMmat4& view, const QMmat4& proj, float time)
{
	if(m_asyncThreadData.active)
		throw std::runtime_error("a background thread is already sorting");

	m_asyncThreadData.active = true;
	m_asyncThreadData.view = view;
	m_asyncThreadData.proj = proj;
	m_asyncThreadData.time = time;
	m_asyncThreadData.sorter = this;

	if(pthread_create(&m_asyncThreadData.thread, nullptr, &Sorter::start_async_thread, &m_asyncThreadData))
		throw std::runtime_error("pthread_create failed");
}

bool Sorter::sort_async_pending() const
{
	return m_asyncThreadData.active;
}

bool Sorter::sort_async_tryjoin()
{
	if(!m_asyncThreadData.active)
		throw std::runtime_error("no background thread is running");
	
	int joinResult = pthread_tryjoin_np(m_asyncThreadData.thread, nullptr);
	if(joinResult == EBUSY)
		return false;

	m_asyncThreadData.active = false;
	return true;
}

const std::vector<uint32_t>& Sorter::get_latest() const
{
	return m_indices;
}

void* Sorter::start_async_thread(void* arg)
{
	AsyncThreadData* data = static_cast<AsyncThreadData*>(arg);
	data->sorter->sort(data->view, data->proj, data->time, true);

	return nullptr;
}

}; //namespace mgs